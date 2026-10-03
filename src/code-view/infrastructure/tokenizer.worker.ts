import {
  createTextMateRuntime,
  grammarForFile,
  metadataForeground,
} from "./textmate";
import {
  TokenizationEngine,
  type ChunkResult,
  type WantedLines,
} from "./tokenization-engine";

interface ContentRequest {
  readonly type: "contentChanged";
  readonly fileId: string;
  readonly contentVersion: number;
  readonly text: string;
}

interface RankRequest {
  readonly type: "rank";
  readonly wanted: readonly WantedLines[];
}

type WorkerRequest = ContentRequest | RankRequest;

interface TokenResponse extends ChunkResult {
  readonly type: "tokens";
}

const workerGlobal = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: TokenResponse, transfer: Transferable[]): void;
};
const stepChannel = new MessageChannel();
const pendingRequests: WorkerRequest[] = [];
let activeEngine: TokenizationEngine | undefined;
let stepScheduled = false;

function applyRequest(
  engine: TokenizationEngine,
  request: WorkerRequest,
): void {
  if (request.type === "contentChanged") {
    engine.contentChanged(request.fileId, request.contentVersion, request.text);
    return;
  }
  engine.rank(request.wanted);
}

function scheduleStep(): void {
  if (stepScheduled) return;
  stepScheduled = true;
  stepChannel.port2.postMessage(undefined);
}

function postResult(result: ChunkResult): void {
  const response: TokenResponse = { type: "tokens", ...result };
  const transfer: Transferable[] = [
    response.runs.buffer,
    response.lineRunOffsets.buffer,
  ];
  if (response.minimap) transfer.push(response.minimap.buffer);
  workerGlobal.postMessage(response, transfer);
}

stepChannel.port1.onmessage = () => {
  stepScheduled = false;
  const result = activeEngine?.step();
  if (!result) return;
  postResult(result);
  scheduleStep();
};

void createTextMateRuntime().then((runtime) => {
  activeEngine = new TokenizationEngine({
    grammarFor: (fileId) => grammarForFile(runtime, fileId),
    foregroundOf: metadataForeground,
  });
  for (const request of pendingRequests) applyRequest(activeEngine, request);
  pendingRequests.length = 0;
  scheduleStep();
});

workerGlobal.onmessage = (event) => {
  if (activeEngine) applyRequest(activeEngine, event.data);
  else pendingRequests.push(event.data);
  scheduleStep();
};
