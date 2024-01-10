export interface Score {
  name: string;
  score: number | null;
  metadata?: Record<string, unknown>;
  error?: unknown;
}

export type ScorerArgs<Output, Extra> = {
  output: Output;
  expected?: Output;
} & Extra;

export type Scorer<Output, Extra> = (
  args: ScorerArgs<Output, Extra>
) => Score | Promise<Score>;
