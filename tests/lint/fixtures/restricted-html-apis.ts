export function render(element: HTMLElement): void {
  element.innerHTML = "";
  element.outerHTML = "";
  element.insertAdjacentHTML("beforeend", "");
  document.write("");
}
