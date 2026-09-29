export interface TraceEvent {
  readonly name: string;
  readonly ts: number;
  readonly dur?: number;
  readonly pid: number;
  readonly tid: number;
  readonly ph?: string;
  readonly id?: string;
  readonly args?: Record<string, unknown>;
}

export interface TraceAnalysis {
  readonly action: string;
  readonly parsedByTraceEngine: boolean;
  readonly traceEngineFrames: number;
  readonly eventCount: number;
  readonly mainThreadTasks: number;
  readonly maxMainThreadTaskMs: number;
  readonly tasksOver8_33Ms: number;
  readonly frameSource: "PipelineReporter";
  readonly framesPresented: number;
  readonly framesDropped: number;
  readonly framesPartiallyPresented: number;
  readonly framesTotal: number;
  readonly eventTimingCount: number;
  readonly eventTimingMaxMs: number;
  readonly eventTimingP95Ms: number;
}

export function analyzeTraceEvents(
  events: readonly TraceEvent[],
  label: string,
): Promise<TraceAnalysis>;

export function loadTraceEvents(path: string): Promise<TraceEvent[]>;
