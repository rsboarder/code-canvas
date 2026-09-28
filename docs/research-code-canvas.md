# Исследование: GPU-канвас 120fps для 200 TS-виджетов (Chrome/macOS)

> Контекст задачи зафиксирован в `openspec/changes/code-canvas/proposal.md` и `specs/*/spec.md` (не редактировались). Отчёт — вход для `design.md`, не сама спека.

---

## TL;DR

Технически достижимо за 2–4 недели, но с одним системным риском вне контроля кода: на macOS Chrome, по данным нескольких независимых страниц с идентичной формулировкой (вероятно, из одного канонического источника), держит композиторные анимации на 60Hz, пока окно браузера не будет один раз изменено в размере после запуска — после этого держится 120Hz до перезапуска `[T3, single — verify]`. Если это подтвердится на эталонной машине, это самый дешёвый и самый опасный риск проекта: без него весь бюджет 8.33мс недостижим независимо от качества рендера. **Первый спайк — не рендер, а измерение фактического интервала rAF в Chrome stable на MacBook Pro ProMotion.**

Архитектурная рекомендация: один общий WebGL2-контекст на весь канвас (у Chrome жёсткий лимит ~16 активных WebGL-контекстов на вкладку `[T3, 2+ sources]` — держать по контексту на виджет невозможно), glyph-atlas с alpha-only (без цвета) + инстансированные квады, цвет токена — per-instance атрибут, а не часть атласа (иначе atlas растёт неограниченно — задокументированный баг именно такого дизайна в xterm.js `[T1, primary]`). Активный Monaco остаётся DOM-оверлеем на главном потоке (не OffscreenCanvas/Worker) — иначе синхронизация позиции редактора с паном канваса кадр-в-кадр требует postMessage-round-trip, что прямо нарушает требование спеки «без отставания ни на один кадр». Токенизация неактивных виджетов — в Web Worker (Monaco tokenizer/Monarch, тот же движок, что у активного редактора — гарантирует совпадение цветов бесплатно).

## Ключевые выводы

- Главный технический риск — не рендер, а Chrome/macOS rAF-throttling до 60Hz без «касания» окна `[T3, single — verify]` ([Chromium issue 40202100](https://issues.chromium.org/issues/40202100), синтез поиска).
- Все изученные high-performance текстовые движки (Zed GPUI, Warp, xterm.js WebGL, Figma) сходятся на одном паттерне: alpha-only glyph atlas + per-instance цвет + один инстансированный draw call `[T1/T2, 2+ sources]` — это не архитектурный выбор с равнозначными альтернативами, это индустриальный консенсус.
- Chrome ограничивает число одновременных WebGL-контекстов на вкладке (эмпирически ~16) `[T3, 2+ sources]` ([Chromium issue 40939743](https://issues.chromium.org/issues/40939743), [virtual-webgl README](https://github.com/greggman/virtual-webgl)) — 200 отдельных `<canvas>` с WebGL невозможны, нужен один общий контекст.
- Shiki в 7 раз медленнее Prism.js на токенизации (0.5–0.7мс vs 3.5–5.0мс на прогон) `[T2, single]` ([chsm.dev benchmark](https://chsm.dev/blog/2025/01/08/comparing-web-code-highlighters)) — но ни один из измеренных инструментов не даёт цветов, тождественных теме Monaco «из коробки»; только Monaco Monarch-токенайзер гарантирует это структурно.
- File System Access API с Chrome 122 поддерживает persistent permissions («Allow on every visit») — снимает проблему «переспрашивать разрешение при каждой перезагрузке» `[T1, primary]` ([Chrome for Developers blog](https://developer.chrome.com/blog/persistent-permissions-for-the-file-system-access-api)).

## Рекомендуемые ресурсы

- [Leveraging Rust and the GPU to render user interfaces at 120 FPS — Zed's Blog](https://zed.dev/blog/videogame) — T1 — эталонное описание glyph-atlas + instanced draw архитектуры, прямая аналогия задаче.
- [Adventures in Text Rendering: Kerning and Glyph Atlases — Warp](https://www.warp.dev/blog/adventures-text-rendering-kerning-glyph-atlases) — T1 — субпиксельное позиционирование глифов, применимо к дробному зуму.
- [Performance • tldraw Docs](https://tldraw.dev/sdk-features/performance) — T1 — готовый набор техник LOD/culling для инфинит-канваса на TS, с конкретными порогами.
- [Chrome DevTools Performance panel reference](https://developer.chrome.com/docs/devtools/performance/reference) — T1 — точное определение dropped/partially-presented frame, нужное для приёмки по спеке.
- [xterm.js glyph atlas unbounded growth issue #6074](https://github.com/xtermjs/xterm.js/issues/6074) — T1 — предупреждающий пример: не делать то, что описано в разделе рисков #3.

---

# Детальный отчёт

## Executive Summary

Задача — построить с нуля (AI-агентами, без ручных правок) веб-канвас на ~200 TS-виджетах, держащий 120fps по строгому DevTools-критерию (p99 между кадрами ≤8.33мс, без dropped/partially-presented) при пане, зуме с LOD-переходами, drag/resize/скролле и наборе текста в единственном активном Monaco-редакторе. Рисёрч подтверждает: технический паттерн для этого — не изобретение, а прямое повторение того, что уже делают Zed, Warp, Figma и WebGL-рендерер xterm.js — glyph atlas + инстансированные квады на GPU, с CPU-стороной, ограниченной обновлением uniform-матрицы камеры для неизменного контента. Главная неопределённость — не в архитектуре рендера, а в поведении самого Chrome на ProMotion-дисплее (см. риск №1) и в инженерной сложности бесшовной стыковки DOM Monaco с GPU-канвасом без единого кадра рассинхронизации (риск №2). Рекомендация: raw WebGL2 (не WebGPU — см. Tradeoff Matrix), Monaco tokenizer в Worker для фоновой подсветки, один WebGL2-контекст на всё приложение, alpha-only glyph atlas.

## Core Findings

### (1) GPU-рендер текста: как это делают лидеры

Единообразная картина по пяти изученным системам:

- **xterm.js WebGL renderer**: полноценный texture atlas (сейчас — несколько текстур 512×512, срастающихся до максимум 4096×4096, раньше — жёсткий кап 1024×1024), Float32Array с данными на отрисовку загружается в один WebGL-шейдер `[T1, primary]` ([xterm.js WebGL Renderer PR #1790](https://github.com/xtermjs/xterm.js/pull/1790), [issue #4065](https://github.com/xtermjs/xterm.js/issues/4065)). Важный антипаттерн задокументирован в issue #6074: если фон ячейки варьируется (например, diff-подсветка), атлас растёт без ограничения, потому что ключ атласа включает цвет фона `[T1, primary]` — это прямое предупреждение для canvas с подсветкой синтаксиса по цвету токена.
- **Zed / GPUI**: ОС рендерит глиф в оттенках серого (только alpha-канал), результат кэшируется в texture atlas; на кадр рендерится до 16 суб-пиксельных вариантов одного глифа для позиционирования; итоговая сборка текста — «единственный инстансированный draw call» `[T1, primary]` ([Zed blog: Leveraging Rust and the GPU](https://zed.dev/blog/videogame)). Прямая цитата про производительность: «approximates the bandwidth of the GPU… it doesn't get any faster than that».
- **Warp**: тот же принцип, но с явным решением проблемы дробного позиционирования — ключ кэша `(font_id, glyph_id, font_size, sub-pixel_alignment)`, три суб-пиксельных варианта на глиф (0.0/0.33/0.66px) вместо бесконечной точности `[T1, primary]` ([Warp: Adventures in Text Rendering](https://www.warp.dev/blog/adventures-text-rendering-kerning-glyph-atlases)).
- **Figma**: движок на C++/Rust, скомпилированный в WASM, рисует через WebGL; текстовый шейпинг — HarfBuzz, причём явная причина ухода от браузерного text layout — несовместимость метрик шрифта между браузерами `[T2, single]` ([Building a professional design tool on the web](https://www.figma.com/blog/building-a-professional-design-tool-on-the-web/)).
- **VS Code experimental GPU renderer** — тот же путь (glyph atlas + WebGL), но статус на 2025–2026 — активно нестабилен: баги наложения строк, курсора не на месте, лигатур, word wrap `[T2, 2+ sources]` (множественные открытые issues в microsoft/vscode: [#238289](https://github.com/microsoft/vscode/issues/238289), [#269471](https://github.com/microsoft/vscode/issues/269471), [#266964](https://github.com/microsoft/vscode/issues/266964)). Вывод для задачи: даже команда Monaco с полным контролем над кодовой базой не довела GPU-рендер до продакшн-качества за годы — это сигнал закладывать реалистичный запас на баги геометрии текста, а не только на производительность.
- **tldraw** использует смешанный подход: React/DOM+SVG для интерактивных фигур, но WebGL специально для минимапы `[T1, primary]` ([tldraw Performance docs](https://tldraw.dev/sdk-features/performance)) — показательная параллель с требуемым LOD «текст/миникарта» задачи.

**Чёткость на дробном зуме.** Ни один источник не даёт числового порога, начиная с которого bitmap-атлас «размывается» на дробном масштабе — `не найдено, нужно замерить`. Общий принцип из источников: bitmap-атлас крепится к конкретному физическому размеру рендера (Zed рендерит через ОС на фактическом DPR, Warp — на конкретный font_size), а не растягивается шейдером на произвольный масштаб; при выходе за диапазон, для которого атлас растеризован, нужен либо re-rasterize (дёшево при debounce), либо SDF/MSDF (дороже по сложности, но continuous-scale по построению). MSDF даёт сохранение острых углов на любом масштабе за счёт трёх дистанс-каналов `[T2, 2+ sources]` ([AlphaPixel SDF vs MSDF vs Slug](https://alphapixeldev.com/sdf-vs-msdf-vs-slug-vs-rive-gpu-text-rendering/), [Red Blob Games SDF+MSDF guide](https://www.redblobgames.com/articles/sdf-fonts/)), ценой чуть более дорогого fragment-шейдера.

### (2) WebGL2 vs WebGPU в Chrome, 2026

WebGPU стабилен в Chrome с версии 113 (desktop), Android — с 121 `[T2, single]` (синтез поиска, без прямой T1-цитаты с номером версии — `verify`). WebGL2 работает по умолчанию во всех основных браузерах без исключений `[T2, single]`. Ни один источник не показал универсального превосходства WebGPU в производительности — оно зависит от ворклоуда; для простых 2D-сцен (наш случай) WebGL2 «всё ещё более чем достаточен» `[T2, single]` ([WebGPU vs WebGL2 сравнение, Volume Shader BM / testmuai синтез](https://www.volumeshader.dev/en/blog/webgl-vs-webgpu)). WebGPU даёт преимущество в первую очередь через compute shaders и меньший CPU overhead на сценах с большим числом draw calls/объектов — не наш профиль, поскольку весь рендер укладывается в 2–4 инстансированных draw call.

По библиотекам:
- **PixiJS v8**: имеет и WebGL, и WebGPU бэкенд, но собственный текст (`Text`) не даёт преимущества WebGPU автоматически — Pixi чаще упирается в CPU-лимиты, а не GPU `[T2, single]`. `BitmapText` — заранее сгенерированные текстуры, дешёвый рендер, «без последствий по производительности при смене текста» `[T1, primary]` ([PixiJS Text guide](https://pixijs.com/8.x/guides/components/scene-objects/text)).
- **regl** — выше уровень абстракции, декларативный, автоматический state management. **twgl.js** — тоньше, ближе к сырому WebGL, больше ручной работы `[T2, 2+ sources]` ([regl vs TWGL сравнение](https://best-of-web.builder.io/library/regl-project/regl), [webgl-libs-comparison](https://github.com/jsulpis/webgl-libs-comparison)).
- **troika-three-text** — SDF-текст поверх three.js, генерация атласа в Worker, опционально GPU-ускоренная `[T1, primary]` ([troika-three-text npm](https://www.npmjs.com/package/troika-three-text)) — сильная референсная реализация, но тянет за собой весь three.js, что избыточно для 2D-канваса.

### (3) LOD и кэширование

Инфраструктура на 200 виджетов не требует классического render-to-texture тайлинга по чанкам экрана (как в картографии) — источники по vello/infinitecanvas.cc описывают тайлинг именно для произвольной векторной графики с большим числом перекрывающихся путей `[T2, single]` ([infinitecanvas.cc Lesson 35](https://infinitecanvas.cc/guide/lesson-035)), что не совпадает с профилем задачи (моноширинный текст, известная структура). Более прямой аналог — tldraw: спрятанные вне вьюпорта фигуры получают `display: none`, что на 10000 фигур даёт рендер ~50 `[T1, primary]` ([tldraw Performance docs](https://tldraw.dev/sdk-features/performance)) — для 200 виджетов это тривиальный AABB-тест, не спрятанные RTT-тайлы.

Практический вывод из синтеза Zed/Warp/xterm.js: **RTT не нужен как основной механизм**. Правильная модель — персистентные instance-буферы на GPU для всех видимых глифов; пан/зум неизменного контента — это только обновление uniform view-projection матрицы камеры, без единого CPU-байта перезаписи геометрии. Перерисовка (пересборка instance-буфера) нужна только когда меняется контент виджета: правка текста, скролл внутри виджета (новое окно видимых строк), пересечение LOD-порога, ресайз (перекраивает только clip-маску — линии не переносятся по спеке, значит не требует re-layout текста). VRAM-бюджет для атласа `не найдено, нужно замерить`; порядок величины оценивается как малый (единицы МБ): при alpha-only хранении глифов ASCII+частые Unicode-символы одного размера укладывается в 1–2 текстуры 512×512 `[author estimate]`, — это оценка по аналогии с xterm.js (текстуры 512×512, срастающиеся до 4096×4096 `[T1, primary]`), не измерение для этой задачи.

### (4) Culling, пространственный индекс, батчинг

При N=200 виджетов брутфорс AABB-тест против прямоугольника вьюпорта на каждый кадр — O(200), не требует quadtree/R-tree; спека прямо допускает деградацию производительности выше 200 файлов, так что усложнение пространственным индексом на старте избыточно `[author estimate]`. Если проект захочет расширяться за 200–350 файлов, готовое решение — `rbush` (R-tree, bulk insert, «в сотни раз быстрее перебора») `[T2, single]` ([RBush README, синтез поиска](https://github.com/alundavies/rbush)). Общий консенсус по quadtree vs R-tree: R-tree/RBush эффективнее для nearest-search на статичных данных, quadtree проще и достаточен для динамических объектов вроде игровых сцен `[T3, 2+ sources]` (GameDev.net, educative.io — оба T3).

Батчинг: инстансированный рендер — стандартный WebGL2-механизм снижения draw calls («вы говорите WebGL, сколько раз повторить одну геометрию, GPU сам итерирует») `[T1, primary]` ([WebGL2 Instanced Drawing, webgl2fundamentals.org](https://webgl2fundamentals.org/webgl/lessons/webgl-instanced-drawing.html)). Для задачи это означает: один instanced draw call на все глифы всех видимых виджетов (общий атлас, общий шейдер), отдельный instanced draw на прямоугольники-«полоски» миникарты, отдельный на фон/рамки/скроллбары виджетов — порядка 3–5 draw calls на кадр суммарно, не 200.

### (5) Главный поток: OffscreenCanvas, события, rAF на 120Hz

**Критично для архитектуры**: OffscreenCanvas+Worker снимает нагрузку с главного потока `[T1, primary]` (web.dev, MDN), но у задачи есть жёсткое встречное требование — DOM-редактор Monaco должен «оставаться совмещённым с виджетом в каждом кадре» во время пана. Monaco рендерится в DOM только на главном потоке; если GPU-канвас рендерится в Worker через OffscreenCanvas, позиционная синхронизация требует postMessage каждый rAF-тик, что вводит ровно тот межкадровый лаг, который спека прямо запрещает. **Рекомендация — держать рендер канваса на главном потоке**, вынося в Worker только вычислительно тяжёлую, не покадровую работу (токенизация, парсинг файлов).

Жест pinch-zoom на трекпаде в Chrome кодируется как `wheel`-событие с `ctrlKey: true`, `deltaY = -100*log(scale)` `[T2, 2+ sources]` ([Chromium web-facing change PSA](https://groups.google.com/a/chromium.org/g/chromium-dev/c/L_kaBhYFi5U/m/RIMFBx12dJoJ), [Dan Burzo: Pinch me, I'm zooming](https://danburzo.ro/dom-gestures/)) — нужно `preventDefault()` на этом событии, чтобы не сработал браузерный зум страницы (прямое требование спеки «Браузерный зум не перехватывает жест»). `getCoalescedEvents()` — API `PointerEvent`, не `WheelEvent`; полезен для drag/resize (высокочастотные `pointermove`), не для распознавания pinch — `[uncertain, требует проверки в реализации]`, явного источника, подтверждающего его применимость к wheel-потоку, не найдено.

**Самый серьёзный отдельный риск задачи**: по нескольким страницам с идентичной формулировкой (похоже, из одного канонического источника, не независимо подтверждено разными авторами) — «Chrome и другие Chromium-браузеры держат скролл на 60Hz, пока окно браузера не изменено в размере, после чего анимация идёт на 120Hz до перезапуска браузера» `[T3, single — verify]` (синтез из поисковой выдачи, первоисточник не идентифицирован напрямую; см. также нерешённый [Chromium issue 40202100 «Support for ProMotion display»](https://issues.chromium.org/issues/40202100)). Если это подтвердится на эталонной машине проекта, ни один архитектурный выбор кода не решит проблему — нужен либо программный триггер ресайза при старте, либо full-screen-режим (спека и так требует full-screen — стоит проверить, достаточно ли самого входа в full-screen для перехода на 120Hz, или нужен именно ресайз окна).

### (6) Токенайзер для неактивных виджетов

Прямое сравнение скорости, T2-источник: Prism.js 0.5–0.7мс/прогон, Highlight.js 1.1–1.4мс, **Shiki 3.5–5.0мс (в 7 раз медленнее Prism)** `[T2, single]` ([chsm.dev, Comparing web code highlighters](https://chsm.dev/blog/2025/01/08/comparing-web-code-highlighters)). Размер бандла: Shiki 279.8 KiB (включает WASM-зависимость через Oniguruma) против 11.7–15.6 KiB у Prism/Highlight.js `[T2, single]`. Прямого числа для tree-sitter-wasm или Lezer в том же тесте `не найдено, нужно замерить`.

Но у задачи есть требование сильнее скорости: **точное совпадение цвета токена с активным Monaco-редактором до и после входа в редактирование**. Ни Shiki, ни tree-sitter, ни Prism не гарантируют этого структурно — потребуется вручную поддерживать mapping их token-scope в Monaco theme colors, риск дрейфа при обновлении темы. **Единственный вариант с нулевым риском рассинхронизации цвета — тот же токенайзер, что использует сам Monaco: `monaco.editor.tokenize()` / движок Monarch**, вызванный headless (без монтирования DOM-редактора) в Worker. Monaco/VS Code уже прошли путь оптимизации этого пути: переход на Trie-based theme resolution и `Uint32Array`-кодирование токенов (язык + тип + стиль + индексы цвета в одном 32-битном слове вместо JS-объектов) дал измеренное ускорение 14.5–46.4% и снижение памяти на 22.6–24.6% на трёх эталонных файлах (1.18МБ TS, 118КБ CSS, 6.73МБ C) `[T1, primary]` ([VS Code blog: Optimizations in Syntax Highlighting](https://code.visualstudio.com/blogs/2017/02/08/syntax-highlighting-optimizations)). Monaco также поддерживает мемоизацию Monarch-состояний до глубины 5 для файлов с большим числом строк `[T2, single]` (CHANGELOG microsoft/monaco-editor).

Скорость на 200×2000 строк конкретно для Monaco tokenizer в Worker `не найдено, нужно замерить` — обязательный пункт спайка (см. ниже). Tree-sitter-wasm и Lezer остаются кандидатами только если Monaco-headless-токенизация в Worker не уложится в бюджет; Lezer (движок CodeMirror 6) специально проектировался под инкрементальный re-parse изменённых участков `[T1, primary]` ([Lezer Parser docs](https://lezer.codemirror.net/)), но требует отдельного маппинга цветов на Monaco-тему, то есть добавляет именно тот риск рассинхронизации, которого нужно избежать.

### (7) Monaco поверх GPU-канваса

Не найдено ни одного публичного разбора именно связки «DOM Monaco как единственный активный редактор + GPU-канвас снизу» с покадровой синхронизацией при пане — это нетривиальная часть архитектуры, специфичная для задачи `не найдено, нужно замерить/спроектировать`. Ближайшие аналоги:
- **tldraw** — три системы координат (screen/viewport/page) с явными трансформациями между ними для DOM-оверлеев поверх канваса `[T1, primary]` ([tldraw viewport-and-camera-control docs](https://tldraw.dev/features/programmatic-control/viewport-and-camera-control)) — прямой паттерн для позиционирования Monaco-контейнера.
- Паттерн «единственный экземпляр Monaco + `setModel()` на переключение файла» подтверждён множественными источниками как рекомендованный (создание нескольких Monaco-инстансов «memory- и performance-intensive») `[T2, 2+ sources]` ([Building a code editor with Monaco, blog.expo.dev](https://blog.expo.dev/building-a-code-editor-with-monaco-f84b3a06deaf); GitHub issues react-monaco-editor #329, monaco-editor #2947).

Практическая рекомендация: единственный DOM-узел Monaco, позиционируемый через `transform: translate()` в том же rAF-колбэке, который обновляет camera-uniform канваса (прямая мутация `style.transform`, не через React re-render, чтобы избежать лишнего React-цикла между кадрами). Вход/выход — переключение видимости GPU-представления виджета и DOM-representation Monaco в один и тот же кадр (спека требует «без промежуточного кадра со старым содержимым»).

### (8) Измерение 120fps

Chrome DevTools Performance panel классифицирует кадры на 4 типа: idle (белый), standard (зелёный, «отрендерен вовремя»), **partially presented** (жёлтый — «часть визуальных изменений не успела, но не критично, например canvas-анимация опоздала, а компоновка скролла — нет»), **dropped** (красный — «Chrome не смог отрендерить кадр за разумное время») `[T1, primary]` ([Chrome DevTools Performance features reference](https://developer.chrome.com/docs/devtools/performance/reference)); категория «partially presented» появилась именно в Chrome 100 как более точная замена универсального «dropped» `[T1, primary]` (тот же источник). Это прямое определение критерия приёмки из спеки performance-budget.

Для автоматизации: Playwright интегрируется с CDP для CPU-профилирования и трейсов; типовой CI-харнесс собирает percentile интервалов кадра (p50/p95/p99), считает «hard stalls» (кадры >50мс) и Long Tasks через Long Tasks API `[T2, single]` (синтез из нескольких практикующих блогов, ни один не T1). Прямая рекомендация из практики: performance-тесты гонять только на Chromium в CI, поскольку и Core Web Vitals, и CPU-throttling через CDP — Chrome-специфичны `[T2, single]`. Готовых open-source CI-харнессов, заточенных именно под «120fps + DevTools frame classification» `не найдено` — спека требует написать собственную команду бенчмарка, готовых библиотек под это не существует, придётся собирать поверх `playwright` + CDP `Tracing.start` / `Performance` domain самостоятельно.

### (9) File System Access API

`showDirectoryPicker()` возвращает `FileSystemDirectoryHandle`, рекурсивный обход подкаталогов — через `entries()`, доступ на запись — явный `{ mode: 'readwrite' }` при получении permission `[T1, primary]` ([MDN: Window.showDirectoryPicker()](https://developer.mozilla.org/en-US/docs/Web/API/Window/showDirectoryPicker), [Chrome for Developers: File System Access API](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access)). Хэндлы **сериализуемы** и могут сохраняться в IndexedDB между сессиями `[T1, primary]` (MDN FileSystemFileHandle) — прямое решение требования спеки «Повторное открытие». С Chrome 122 доступен **persistent permissions**: трёхвариантный prompt «Allow this time / Allow on every visit / Don't allow» — при выборе второго варианта разрешение переживает перезапуск без повторного запроса `[T1, primary]` ([Chrome for Developers blog: Persistent permissions for the File System Access API](https://developer.chrome.com/blog/persistent-permissions-for-the-file-system-access-api)). Ограничение: если пользователь отклонит/закроет prompt больше трёх раз, расширенный prompt перестаёт показываться и откатывается на стандартный `[T1, primary]` (тот же источник). Практическая схема для 200+ файлов: сохранить хэндл папки (не 200 файловых хэндлов), при старте — `queryPermission()`, при отказе — `requestPermission()` с явным пользовательским действием (клик), затем рекурсивный обход заново.

### (10) Похожие open-source проекты

- **Haystack Editor** — форк VS Code с канвас-UI, автоматически рисующим связи между файлами при навигации; исходники доступны под PolyForm Strict License 1.0.0 `[T1, primary]` ([GitHub: haystackeditor/haystack-editor](https://github.com/haystackeditor/haystack-editor); подтверждение форка VS Code — [AlternativeTo](https://alternativeto.net/software/haystack-ide)). Технические детали рендера в публичной документации не раскрыты `не найдено` — стоит прочитать исходники репозитория напрямую, если потребуется больше деталей их подхода к DOM/канвас гибриду (у них тоже DOM-редактор VS Code поверх канваса — прямой архитектурный аналог задачи).
- **CodeCanvas** (codecanvas.app) — «увидеть код на бесконечном канвасе»; отдельная VS Code extension версия уступает место standalone-версии, которая, по их собственному объявлению, «rebuilt using WebGL to enable hardware acceleration for better performance on large codebases» `[T2, single]` (синтез страницы, полного технического описания не получено — публичная документация на момент рисёрча не раскрывает деталей рендера).
- **Code Canvas (Microsoft Research)** — упоминается как «research prototype focused on spatial orientation of code… spatial 2.5D representation… infinite panning and semantic zoom» `[T3, single]` (обрывочное упоминание в результатах поиска, официальный источник не найден напрямую в этом прогоне) — концептуально почти точное совпадение с задачей («semantic zoom» ≈ LOD), стоит доискать первоисточник (Microsoft Research публикации начала 2010-х под тем же названием) отдельно, если нужны детали.
- **Cate** — «infinite zoomable canvas for coding» для параллельных AI-агентов (не для одного человека, редактирующего код) — иной use-case, но структурно близкий канвас `[T3, single]` ([GitHub: 0-AI-UG/cate](https://github.com/0-AI-UG/cate)).
- **Ideon** — «Spatial Workspace» с акцентом на планирование архитектуры и мультифайловый обзор; технические детали рендера не раскрыты `не найдено` ([theideon.com](https://www.theideon.com/use-cases/infinite-canvas-for-developers)).

Что подсмотреть предметно: у Haystack и старой VS Code extension версии Code Canvas — как именно DOM-редактор VS Code уживается с канвас-обвязкой (оба построены на форке/расширении VS Code, то есть на том же Monaco-ядре, что и наша задача) — рекомендуется прочитать их исходники по `src/`, а не полагаться на маркетинговые страницы.

## Tradeoff Matrix — WebGL2 (raw/twgl) vs WebGPU vs PixiJS v8 vs troika/three.js

| Ось | Raw WebGL2 + twgl.js | WebGPU (raw) | PixiJS v8 | troika (three.js) |
|---|---|---|---|---|
| Поддержка в Chrome 2026 | Универсальная, 100% `[T2, single]` | Стабильна с Chrome 113, но 2–4 недели без права на platform-риски — узкое окно `[T2, single]` | Наследует поддержку WebGL2/WebGPU бэкендов | Наследует WebGL2 через three.js |
| Контроль над glyph atlas / per-instance цвет | Полный, минимальный риск скрытых абстракций | Полный, но больше boilerplate (pipelines, bind groups) | Средний — придётся обходить `Text`/`BitmapText` API, писать custom Mesh/Geometry | Ограничен SDF-моделью troika, заточен под 3D-сцены |
| Риск для срока 2–4 недели (AI-агенты) | Средний — пишется с нуля, но паттерн задокументирован у 4 независимых лидеров (п.1) | Высокий — меньше зрелых референсов именно под текст, меньше учебных материалов для LLM-агентов | Низкий — готовый culling/batching/scene graph снижает объём кода с нуля | Высокий — тянет three.js целиком, оверхед на 2D-задачу, документация про SDF, не про code-widgets |
| Соответствие индустриальному паттерну (Zed/Warp/xterm.js/Figma) | Прямое совпадение | Совпадает концептуально (Warp использует wgpu = WebGPU-модель), но не в браузере | Частичное — batching да, но не alpha-only atlas из коробки | Частичное — SDF, не bitmap-atlas |
| Отладочная зрелость инструментов (DevTools, трассировка) | Высокая, WebGL инспектируется давно | Ниже, WebGPU-профилирование в DevTools моложе `[author estimate]` | Высокая (свой debug layer) | Высокая (three.js devtools) |

**Рекомендация**: raw WebGL2 + тонкий helper (twgl.js) для устранения boilerplate, без полноценного фреймворка. Причина, перевешивающая «PixiJS снижает объём кода»: у задачи специфический, нетиповой пиксельный контракт (alpha-only atlas + per-instance color + два LOD-представления с бесшовным кроссфейдом) — попытка выразить это через чужой scene graph рискует потребовать столько же кастомного кода, сколько и «с нуля», но с дополнительным слоем непрозрачности фреймворка поверх. WebGPU — не как основной путь для 2–4-недельного окна: паттерн задачи не требует compute shaders, а зрелость инструментов/референсов для именно 2D bitmap text ниже, чем у WebGL2.

## Weaknesses of the Recommended Option

- **Raw WebGL2 без фреймворка увеличивает объём написанного с нуля кода** (нет готового batcher/scene-graph) — для AI-агентов это больше поверхности для багов геометрии/состояния, чем при PixiJS. Триггер к пересмотру: если после спайка B (день 1) базовый рендерер занимает заметно больше времени/итераций, чем закладывалось — переключиться на PixiJS v8 с custom Mesh для glyph-quads (Pixi даёt batching бесплатно, alpha-only atlas всё равно пишется руками поверх его `Texture`/`Geometry` API).
- **Monaco на главном потоке (не Worker) означает, что вся JS-логика ввода/токенизации-диспетчеризации конкурирует с рендером канваса за тот же 8.33мс бюджет** — если фоновая работа (не токенизация, а именно диспетчеризация/логика LOD/state) окажется тяжелее ожидаемого, единственный путь останется — жёсткая дисциплина по времени задач (chunking, `requestIdleCallback`), а не перенос в Worker (что запрещено требованием нулевого лага Monaco).
- **Alpha-only glyph atlas с per-instance цветом усложняет фрагментный шейдер и координацию LOD-минимапы** (полоски минимапы — не глифы, отдельный draw call/геометрия) — стыковка двух представлений без «popping» (требование спеки) технически сложнее, чем в системах-аналогах (ни Zed, ни Warp, ни Figma не имеют LOD-минимапы как альтернативного представления того же контента).

## Common Pitfalls & Solutions

**Pitfall 1: Atlas-ключ включает цвет фона/токена**
- **Почему это происходит**: естественное первое решение — «нарисовать глиф нужным цветом и закэшировать растровый результат», как показывает даже история xterm.js.
- **Решение**: alpha-only атлас (только форма буквы), цвет — per-instance vertex attribute, применяется в fragment shader умножением на alpha-семпл. Подтверждено архитектурой Zed.
- **Источник**: [xterm.js issue #6074](https://github.com/xtermjs/xterm.js/issues/6074) `[T1, primary]`; [Zed blog](https://zed.dev/blog/videogame) `[T1, primary]`.

**Pitfall 2: Один `<canvas>` с WebGL-контекстом на виджет**
- **Почему это происходит**: концептуально проще — «виджет = независимый маленький канвас».
- **Решение**: один общий WebGL2-контекст на всё приложение, виджеты — область в world-space одной большой сцены, а не отдельные DOM/GPU-сущности.
- **Источник**: эмпирический лимит ~16 контекстов на вкладку в Chrome `[T3, 2+ sources]` ([Chromium issue #40939743](https://issues.chromium.org/issues/40939743), [virtual-webgl](https://github.com/greggman/virtual-webgl)).

**Pitfall 3: OffscreenCanvas+Worker для «производительности», без учёта требования DOM-синхронизации**
- **Почему это происходит**: OffscreenCanvas — общепринятый совет «разгрузить рендер с главного потока» `[T1, primary]` (web.dev), без учёта, что в этой задаче Monaco всё равно должен жить на главном потоке.
- **Решение**: держать GPU-рендер на главном потоке специально ради нулевого лага DOM-оверлея; выносить в Worker только некадровую работу (токенизация, парсинг файлов, вычисление лэйаута при открытии папки).
- **Источник**: анализ требований code-editing spec («редактор SHALL оставаться совмещённым с виджетом в каждом кадре») + [MDN OffscreenCanvas](https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas) `[author estimate, основан на прямом противоречии требований]`.

**Pitfall 4: Токенайзер, не совпадающий по цвету с Monaco-темой**
- **Почему это происходит**: Shiki/tree-sitter/Lezer — все привлекательны по скорости/фичам, но используют собственную модель scope→цвет, отдельную от Monaco theme.
- **Решение**: использовать `monaco.editor.tokenize()`/Monarch headless в Worker — тот же движок, что красит активный редактор, структурно исключает рассинхронизацию.
- **Источник**: требование code-widget-rendering spec «Одинаковые цвета с редактором» + [VS Code tokenization blog](https://code.visualstudio.com/blogs/2017/02/08/syntax-highlighting-optimizations) `[T1, primary]`.

**Pitfall 5: Chrome не выходит на 120Hz без явного триггера**
- **Почему это происходит**: неочевидное поведение композитора Chrome на macOS, не задокументированное в официальных доках `[T3, single — verify]`.
- **Решение**: замерить фактический интервал rAF на целевой машине до старта разработки рендера (спайк A); если подтверждается — программно спровоцировать переход (ресайз/fullscreen-toggle при старте) и задокументировать как часть эталонной среды запуска.
- **Источник**: синтез поисковой выдачи, [Chromium issue 40202100](https://issues.chromium.org/issues/40202100) (открыт, не разрешён) `[T3, single — verify]`.

## Implementation Guide

**Шаг 1 — Подтвердить или опровергнуть 120Hz-throttling Chrome на эталонной машине**
- **Action**: минимальная HTML-страница с `requestAnimationFrame`-циклом, логирующим `performance.now()`-дельты в массив; открыть в Chrome stable на MacBook Pro ProMotion, full-screen, замерить первые 5 секунд без ресайза, затем после одного ресайза/fullscreen-toggle.
- **Verification**: медиана дельты между кадрами ≈8.33мс (120Hz) против ≈16.67мс (60Hz) в обоих режимах; сверить также через DevTools Performance trace (Frames track).
- **Common failure & recovery**: если 120Hz не достигается даже после ресайза — эскалировать как блокер всего проекта до начала прочей разработки; проверить `chrome://gpu` на предмет hardware acceleration disabled.

**Шаг 2 — Минимальный WebGL2 glyph-atlas рендерер (без канваса/панорамирования)**
- **Action**: один `<canvas>`, WebGL2-контекст, статический alpha-only atlas на ASCII+частые unicode символы (растеризован через `OffscreenCanvas 2D` в один текстурный проход), инстансированный draw call на ~50 000 квадов-глифов (аппроксимация худшего случая — 200 виджетов × ~250 видимых глифов).
- **Verification**: DevTools trace — GPU submission time на кадр, целевое <2мс; ручная проверка чёткости текста на DPR2 скриншотом 1:1.
- **Common failure & recovery**: если glyph выглядит размыто на дробном масштабе — проверить, не сэмплируется ли атлас `LINEAR` вместо `NEAREST` при целочисленном соответствии текселей пикселям; при системном размытии на всех масштабах — рассмотреть переход на MSDF (см. Weaknesses).

**Шаг 3 — Monaco DOM-оверлей + синхронизация позиции с паном**
- **Action**: смонтировать Monaco в `position: absolute` контейнере поверх канваса; в общем rAF-колбэке обновлять и camera-uniform WebGL, и `container.style.transform` одним и тем же вычисленным значением камеры.
- **Verification**: быстрый drag канваса при активном редакторе → покадровый скриншот/трейс не показывает визуального сдвига редактора относительно фона виджета ни на одном кадре.
- **Common failure & recovery**: если синхронизация обновляется через React state/`useEffect` — типичная причина одного кадра лага; переключить на прямую императивную мутацию DOM в rAF-хендлере, минуя React reconciliation для этого конкретного свойства.

**Шаг 4 — Tokenizer worker + LOD/минимапа**
- **Action**: вызвать headless `monaco.editor.tokenize()` в Worker на файле; получить token runs (offset, length, цвет), одновременно использовать те же runs для генерации цветных полосок минимапы (один источник данных на оба представления).
- **Verification**: сравнить цвет одного и того же токена в headless-результате и в реальном активном Monaco-редакторе на той же теме — побайтовое совпадение RGB.
- **Common failure & recovery**: если Worker не может инстанцировать `monaco.editor` API напрямую (часть Monaco зависит от DOM) — использовать `createModel()` + `tokenize()` без монтирования `create()` редактора, либо изолировать только Monarch tokenizer-часть.

## Performance & Scale Considerations

Готовых бенчмарков «Monaco tokenizer на 200 файлах по 2000 строк в Worker» `не найдено, нужно замерить`; готового бенчмарка «сколько инстансированных глифов WebGL2 держит 120fps на Apple Silicon GPU» `не найдено, нужно замерить`. Единственная количественная опора — единичный измеренный тест токенизации трёх файлов (VS Code blog, п.6) и общий принцип «instanced draw = один вызов на geometry × N», без числовых верхних границ для этого железа. **Все количественные бюджеты ниже — авторская оценка на основе архитектурных аналогий, не измерение; обязательны к верификации автоматическим бенчмарком, который сама спека требует построить.**

## Security Considerations

File System Access API требует secure context (HTTPS/localhost) `[T1, primary]` (MDN). Запись на диск — только после явного пользовательского жеста (открытие папки) и с explicit `readwrite`-разрешением `[T1, primary]`. Хранение хэндлов в IndexedDB безопасно в пределах origin (permissions origin-bound), но сами хэндлы не должны передаваться за пределы страницы/воркера без контроля — не найдено специфичных для задачи угроз сверх стандартной модели FSA API.

## Additional Resources

**Essential Reading (T1/T2)**
- [Zed: Leveraging Rust and the GPU to render UIs at 120 FPS](https://zed.dev/blog/videogame) — эталонная архитектура glyph atlas.
- [Warp: Adventures in Text Rendering](https://www.warp.dev/blog/adventures-text-rendering-kerning-glyph-atlases) — субпиксельное позиционирование.
- [Chrome DevTools Performance features reference](https://developer.chrome.com/docs/devtools/performance/reference) — точная семантика dropped/partial frames.
- [VS Code: Optimizations in Syntax Highlighting](https://code.visualstudio.com/blogs/2017/02/08/syntax-highlighting-optimizations) — обоснование выбора Monarch/Monaco tokenizer.
- [Chrome for Developers: Persistent permissions for FSA API](https://developer.chrome.com/blog/persistent-permissions-for-the-file-system-access-api)

**Further Exploration (T2/T3)**
- [tldraw Performance docs](https://tldraw.dev/sdk-features/performance)
- [chsm.dev: Comparing web code highlighters](https://chsm.dev/blog/2025/01/08/comparing-web-code-highlighters)
- [Haystack Editor GitHub](https://github.com/haystackeditor/haystack-editor)

**Tools & Libraries**
- [twgl.js](https://github.com/greggman/twgl.js/) — тонкий WebGL2-helper.
- [rbush](https://github.com/alundavies/rbush) — R-tree пространственный индекс, если понадобится за пределами 200 файлов.
- [monaco-editor](https://github.com/microsoft/monaco-editor) — активный редактор + источник tokenizer/theme для неактивных виджетов.

---

# Дополнительные разделы (по требованию задачи)

## Выводы по вопросам (1)–(10) со ссылками

**(1) GPU-рендер текста.** Индустриальный консенсус (Zed, Warp, Figma, xterm.js WebGL, частично VS Code) — alpha-only glyph atlas + per-instance цвет + инстансированные квады, один draw call на весь текст сцены. MSDF — резервный вариант для произвольного continuous-zoom, если bitmap-атлас окажется недостаточно чётким на дробном масштабе (не измерено). Источники: [Zed blog](https://zed.dev/blog/videogame), [Warp blog](https://www.warp.dev/blog/adventures-text-rendering-kerning-glyph-atlases), [Figma blog](https://www.figma.com/blog/building-a-professional-design-tool-on-the-web/), [xterm.js WebGL PR #1790](https://github.com/xtermjs/xterm.js/pull/1790), [AlphaPixel SDF/MSDF](https://alphapixeldev.com/sdf-vs-msdf-vs-slug-vs-rive-gpu-text-rendering/).

**(2) WebGL2 vs WebGPU.** WebGL2 — рекомендация по умолчанию: универсальная поддержка, зрелая экосистема, профиль задачи (2D, мало draw calls) не использует сильные стороны WebGPU (compute, множество draw calls). Raw WebGL2 + twgl.js предпочтительнее PixiJS/troika/regl для этой конкретной нетиповой задачи (см. Tradeoff Matrix). Источники: [WebGL2 vs WebGPU синтез](https://www.volumeshader.dev/en/blog/webgl-vs-webgpu), [PixiJS Text guide](https://pixijs.com/8.x/guides/components/scene-objects/text), [regl vs TWGL](https://best-of-web.builder.io/library/regl-project/regl).

**(3) LOD и кэширование.** RTT-тайлинг не требуется как основной механизм при N=200; персистентные GPU-буферы + обновление только camera-uniform при неизменном контенте — основной путь. VRAM-бюджет `не найдено, нужно замерить`, оценка — единицы МБ на атлас. Источники: [tldraw Performance](https://tldraw.dev/sdk-features/performance), [infinitecanvas.cc Lesson 35](https://infinitecanvas.cc/guide/lesson-035), [xterm.js issue #4065](https://github.com/xtermjs/xterm.js/issues/4065).

**(4) Culling/батчинг.** При N=200 — брутфорс AABB-culling достаточен, quadtree/R-tree избыточны (резерв на расширение — rbush). Батчинг — инстансирование, 3–5 draw calls на кадр суммарно. Источники: [WebGL2 Instanced Drawing](https://webgl2fundamentals.org/webgl/lessons/webgl-instanced-drawing.html), [rbush](https://github.com/alundavies/rbush).

**(5) Главный поток и rAF на 120Hz.** GPU-рендер — на главном потоке (не OffscreenCanvas/Worker), чтобы не нарушить требование нулевого лага Monaco. Pinch = `wheel` + `ctrlKey`. **Критический неподтверждённый риск**: Chrome на macOS может не достигать 120Hz без явного триггера (ресайз/fullscreen) — `[T3, single — verify]`, первый спайк проекта. Источники: [Chromium PSA о pinch-as-wheel](https://groups.google.com/a/chromium.org/g/chromium-dev/c/L_kaBhYFi5U/m/RIMFBx12dJoJ), [Chromium issue 40202100](https://issues.chromium.org/issues/40202100).

**(6) Токенайзер.** Headless Monaco Monarch tokenizer в Worker — единственный вариант со структурной гарантией совпадения цвета с активным редактором; Shiki в 7× медленнее Prism и не даёт этой гарантии; tree-sitter/Lezer быстрее по общей репутации, но не измерены в этом прогоне и требуют ручного маппинга цветов. Источники: [chsm.dev benchmark](https://chsm.dev/blog/2025/01/08/comparing-web-code-highlighters), [VS Code tokenization blog](https://code.visualstudio.com/blogs/2017/02/08/syntax-highlighting-optimizations), [Lezer docs](https://lezer.codemirror.net/).

**(7) Monaco поверх GPU-канваса.** Один экземпляр Monaco + `setModel()` на переключение файла — подтверждённый паттерн. Синхронизация позиции — императивная DOM-мутация в общем rAF-колбэке с камерой канваса, не через React state. Прямых источников по именно этой связке не найдено — спроектировано по аналогии с tldraw viewport coordinate spaces. Источники: [tldraw viewport docs](https://tldraw.dev/features/programmatic-control/viewport-and-camera-control), [Building a code editor with Monaco](https://blog.expo.dev/building-a-code-editor-with-monaco-f84b3a06deaf).

**(8) Измерение 120fps.** Chrome DevTools классифицирует кадры как idle/standard/partially-presented/dropped — это и есть критерий приёмки спеки. Готовых CI-харнессов под «120fps + frame classification» не существует, нужно строить поверх Playwright + CDP `Tracing`/`Performance` domain самостоятельно. Источники: [Chrome DevTools Performance reference](https://developer.chrome.com/docs/devtools/performance/reference), синтез практики Playwright+CDP (T2, без единого T1-фреймворка).

**(9) File System Access API.** Рекурсивный обход через `entries()`, `readwrite`-permission явно, хэндлы сериализуемы в IndexedDB, с Chrome 122 доступны persistent permissions («Allow on every visit»). Источники: [MDN showDirectoryPicker](https://developer.mozilla.org/en-US/docs/Web/API/Window/showDirectoryPicker), [Chrome persistent permissions blog](https://developer.chrome.com/blog/persistent-permissions-for-the-file-system-access-api).

**(10) Похожие проекты.** Haystack Editor (форк VS Code) и старая VS Code-extension версия CodeCanvas — ближайшие прямые аналоги (DOM Monaco/VS Code поверх канвас-обвязки); их исходники стоит прочитать напрямую, публичные страницы не раскрывают рендер-детали. Источники: [Haystack Editor GitHub](https://github.com/haystackeditor/haystack-editor), [CodeCanvas](https://www.codecanvas.app/).

## Рекомендуемая архитектура

**Компоненты:**

1. **Camera / Viewport Controller** (главный поток) — единственный источник истины для pan/zoom-состояния; владеет rAF-циклом; на каждый тик обновляет: (a) view-projection uniform WebGL-рендерера, (b) `transform` DOM-контейнера активного Monaco (если открыт), (c) видимость LOD-представлений.
2. **Input Layer** (главный поток) — обработчики `wheel` (pan/pinch-zoom), `pointerdown/move/up` (drag виджета, resize, выделение пустого места для пана мышью), `keydown` (Escape, Shift+0/1, ввод в Monaco). Разруливает конфликт «скролл внутри виджета vs пан канваса» по правилам спеки canvas-viewport/code-widget-rendering.
3. **Scene / Widget Store** (главный поток, in-memory) — реестр 200 виджетов: путь файла, world-space позиция/размер, z-order, scroll-offset, LOD-состояние, ссылка на instance-буфер сегмент. Источник для AABB-culling.
4. **WebGL2 Renderer** (главный поток, один shared context) — держит: общий glyph atlas (текстура), instance-буферы (глифы, полоски-минимапа, фон/рамки виджетов), 3–5 шейдерных пайплайнов, выполняет draw calls на каждый rAF-тик culled-подмножества.
5. **Tokenizer Worker** — headless `monaco.editor.tokenize()`/Monarch; принимает содержимое файла, возвращает token runs (offset, length, colorIndex); используется и для построения instance-данных глифов (Text LOD), и для полосок минимапы (Minimap LOD) — один источник данных на оба представления.
6. **Monaco Host** (главный поток, DOM) — единственный монтированный экземпляр `monaco.editor.create()`, переключение файла через `setModel()`; контейнер спозиционирован абсолютно поверх канваса, видим только для активного виджета.
7. **Filesystem Adapter** — обёртка над File System Access API: открытие папки, рекурсивный обход `.ts/.tsx` с фильтрацией `node_modules/.git/dist/build`, чтение файлов, debounced (≤1с) запись правок, хранение/восстановление `FileSystemDirectoryHandle` через IndexedDB, конфликт-детект (сравнение `lastModified`/содержимого при входе в редактирование).
8. **Layout/Persistence Store** — позиции/размеры/z-order/scroll виджетов + камера, per-folder, сохранение в IndexedDB/localStorage (не файловая система — раскладка не часть содержимого файлов) с debounce ≤1с.
9. **Perf Overlay + Benchmark Runner** — overlay читает те же метрики (fps, p99 интервал, число видимых виджетов, LOD), что собирает headless CI-бенчмарк на Playwright+CDP; оба потребителя одного и того же internal metrics-объекта, чтобы не дублировать логику измерения.

**Потоки данных (ключевые):**

- **Открытие папки**: Filesystem Adapter → список файлов → Scene Store (создание 200 виджетов, начальная сеточная раскладка) → Tokenizer Worker (батч на все файлы, по приоритету видимых) → инстанс-данные глифов/полосок → WebGL2 Renderer (первичная заливка буферов) → Camera Controller восстанавливает сохранённую камеру из Layout Store.
- **Пан/зум без пересечения LOD-порога**: Input Layer → Camera Controller (обновление view-projection) → WebGL2 Renderer (тот же draw call, новый uniform) — **без обращения к Tokenizer Worker или Scene Store**, кроме culling-пересчёта видимого множества виджетов.
- **Зум через LOD-порог**: Camera Controller детектит пересечение порога для виджета → Scene Store переключает LOD-флаг → Renderer кроссфейдит два уже готовых представления (глифы/полоски) по opacity в течение небольшого зум-диапазона (гистерезис против попинга).
- **Drag/resize виджета**: Input Layer → Scene Store (обновление world-space позиции/размера этого виджета) → Renderer (обновление только instance-данных этого виджета, не всей сцены) → Layout Store (debounced запись).
- **Двойной клик → вход в редактирование**: Input Layer детектит dblclick на Text-LOD виджете → Filesystem Adapter перечитывает файл с диска (конфликт-проверка) → Monaco Host `setModel()` + позиционирование поверх виджета → Scene Store скрывает GPU-представление этого виджета → Camera Controller с этого кадра также обновляет transform Monaco Host.
- **Набор текста**: Monaco Host (нативный DOM-рендер Monaco, вне GPU-конвейера) → debounce ≤1с → Filesystem Adapter пишет на диск; параллельно (не блокируя ввод) — обновление in-memory content для будущего headless-re-tokenize при выходе из редактирования.
- **Выход из редактирования**: Monaco Host передаёт финальный текст → Tokenizer Worker пересчитывает token runs для этого файла → Renderer перестраивает instance-данные виджета → Scene Store показывает GPU-представление в том же кадре, где Monaco Host скрывается (спека требует «без промежуточного кадра со старым содержимым»).

## Бюджет кадра по стадиям (мс), цель p99 ≤ 8.33мс

`Все значения — авторская оценка [author estimate] по аналогии с архитектурами из раздела (1)/(4)/(5), НЕ измерение для этого стека и этого железа. Обязательна верификация автоматическим бенчмарком (требование performance-budget spec).`

| Стадия | Когда выполняется | Оценка, мс | Комментарий |
|---|---|---|---|
| Обработка входных событий (wheel/pointer → обновление camera state) | Каждый кадр с активным жестом | 0.2–0.4 | Чистая математика, без аллокаций в горячем пути |
| AABB-culling видимых виджетов | Каждый кадр | 0.1–0.3 | O(200), брутфорс достаточен |
| Обновление instance-буферов (только изменившиеся виджеты: drag/resize/scroll/LOD-переход) | Только при изменении, не при чистом пане/зуме | 0–2.0 | 0 в устойчивом пане; пик — при массовом пересечении LOD-порога у многих виджетов одновременно (см. Pitfall/риск 5) |
| WebGL2 draw calls (CPU submission, 3–5 инстансированных вызовов) | Каждый кадр | 0.3–0.8 | Само GPU-время рендера параллельно CPU, не блокирует последовательно при правильном pipelining |
| Позиционирование Monaco DOM-оверлея (`style.transform`) | Каждый кадр при активном редакторе | 0.1–0.3 | CSS transform, композитится отдельным слоем |
| Резерв на GC/непредвиденные задачи браузера | Каждый кадр | 1.5–2.5 | Буфер, не конкретная стадия — закладывается из-за неизмеренности остального |
| **Итого (сумма верхних оценок)** | | **≈6.5–8.6** | На грани бюджета 8.33мс — подтверждает, что бюджет достижим только при дисциплинированной реализации, без права на «лишний» JS в горячем пути |

Отдельно вне JS-бюджета: фоновая токенизация (Worker) и файловый I/O не входят в этот бюджет по построению (другой поток/асинхронные API), что и есть архитектурный смысл их вынесения — требование performance-budget spec «Отсутствие фоновых просадок» реализуется именно этим разделением, а не оптимизацией самой токенизации.

## Топ-5 рисков и меры снижения

1. **Chrome/macOS не выходит на 120Hz rAF без явного триггера** `[T3, single — verify]`. Единственный источник риска вне контроля кода — если подтвердится и не найдётся программного обхода, весь критерий приёмки спеки становится недостижим независимо от качества реализации. *Митигация*: спайк A в первый день (см. ниже) до написания любого рендер-кода; при подтверждении — программный триггер ресайза/fullscreen-toggle при старте приложения, задокументированный как часть эталонной среды.
2. **Рассинхронизация DOM Monaco и GPU-канваса на кадр во время пана**. Спека требует буквально нулевого лага — малейшая асинхронность (React state, лишний тик) видна как дрожание/отставание текста. *Митигация*: единая rAF-функция, императивная DOM-мутация вместо React re-render для transform, спайк C день 2 с покадровой видео/трейс-проверкой.
3. **Комбинаторный взрыв glyph atlas при наивном baking цвета в атлас** (задокументированный антипаттерн в xterm.js). *Митигация*: alpha-only atlas + per-instance цвет с самого первого прототипа (спайк B), не как поздняя оптимизация.
4. **Главный поток перегружен фоновой работой (токенизация/диспетчеризация) в момент интерактивности**, несмотря на решение держать рендер на главном потоке. *Митигация*: вся токенизация — в Worker с самого начала (спайк D), `requestIdleCallback`/chunking для любой не-токенизационной фоновой логики на главном потоке.
5. **«Попинг»/мигание на LOD-переходах при большом числе одновременно пересекающих порог виджетов** (худший случай, явно выделенный в спеке performance-budget как отдельный сценарий приёмки). *Митигация*: оба представления (текст/минимапа) всегда готовы заранее (не строятся лениво на пересечении порога), переход — только смена opacity/видимости в буфере; спайк E день 3 специально воспроизводит худший случай плотности.

## Спайки/прототипы на первые 2–3 дня

**День 1**
- **Спайк A — измерение фактического rAF-интервала Chrome/macOS.** Минимальная страница, лог дельт `performance.now()` между кадрами, в окне и после ресайза/fullscreen, на целевом MacBook Pro ProMotion. Снимает риск №1. Побочный результат — скелет DevTools-trace-харнеса, переиспользуемый для Q8/финального CI-бенчмарка.
- **Спайк B — минимальный WebGL2 alpha-only glyph-atlas рендерер**, ~50 000 инстансированных квадов (аппроксимация худшего случая 200 виджетов), один shared context, один draw call. Снимает риск №3, валидирует базовый рендер-бюджет из раздела «Бюджет кадра».

**День 2**
- **Спайк C — Monaco DOM-оверлей поверх панорамируемого канваса**, покадровая проверка отсутствия лага при быстром drag. Снимает риск №2.
- **Спайк D — headless Monaco tokenizer в Worker на реальном файле 2000 строк**, замер wall-time, сверка цвета токена 1:1 с активным редактором той же темы. Снимает риск №4, даёт первое реальное число для «Performance & Scale Considerations» (сейчас помечено как «не найдено, нужно замерить»).

**День 3**
- **Спайк E — LOD-переход при максимальной плотности** (воспроизведение сценария «Худший случай плотности текста» из performance-budget spec: столько виджетов на Text LOD, сколько влезает на экран, + зум через порог) с записью DevTools-трейса, проверка на dropped/partially-presented кадры. Снимает риск №5.
- **Спайк F — File System Access API round-trip**: открытие папки 200 файлов, debounced запись правки, сохранение/восстановление `FileSystemDirectoryHandle` через IndexedDB после перезагрузки страницы, проверка UX персистентного permission-prompt. Де-риск Q9 до начала полноценной интеграции с raскладкой/сохранением.

Итог трёх дней: если спайки A/B/C/D/E/F проходят — все пять топ-рисков сняты или сведены к известным численным бюджетам, и оставшиеся 2–4 недели — интеграционная работа по уже провалидированной архитектуре, а не архитектурный поиск.
