export type BreakerState = "closed" | "open" | "half-open";

export interface CircuitBreakerOptions {
  /** Consecutive failures that open the circuit. */
  threshold: number;
  /** Time the circuit stays open before allowing one trial request. */
  cooldownMs: number;
  now?: () => number;
}

/** Minimal consecutive-failure circuit breaker with a single half-open trial. */
export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private trialInFlight = false;
  private stateValue: BreakerState = "closed";
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(options: CircuitBreakerOptions) {
    this.threshold = options.threshold;
    this.cooldownMs = options.cooldownMs;
    this.now = options.now ?? Date.now;
  }

  get state(): BreakerState {
    if (this.stateValue === "open" && this.now() - this.openedAt >= this.cooldownMs) {
      this.stateValue = "half-open";
      this.trialInFlight = false;
    }
    return this.stateValue;
  }

  /** Returns true if a request may proceed now. */
  allow(): boolean {
    const s = this.state;
    if (s === "closed") return true;
    if (s === "half-open" && !this.trialInFlight) {
      this.trialInFlight = true;
      return true;
    }
    return false;
  }

  onSuccess(): void {
    this.failures = 0;
    this.trialInFlight = false;
    this.stateValue = "closed";
  }

  onFailure(): void {
    this.trialInFlight = false;
    if (this.stateValue === "half-open") {
      this.open();
      return;
    }
    this.failures += 1;
    if (this.failures >= this.threshold) this.open();
  }

  private open(): void {
    this.stateValue = "open";
    this.openedAt = this.now();
    this.failures = 0;
  }
}
