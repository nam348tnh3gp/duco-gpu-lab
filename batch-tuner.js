// Adaptive batch-size tuner.
//
// Keeps a short rolling median of the last few batch times so a single outlier
// (a GC pause, a background tab stall, a job boundary) cannot move the size.
// After every change, samples are cleared so the tuner must re-observe the new
// size before it can move again — a natural cooldown that stops oscillation.
export class BatchTuner {
  constructor(sizes, { minimumMs = 55, maximumMs = 95, targetMs = 75, window = 5 } = {}) {
    this.sizes = [...sizes].sort((a, b) => a - b);
    this.minimumMs = minimumMs;
    this.maximumMs = maximumMs;
    this.targetMs = targetMs;
    this.window = window;
    this.reset();
  }

  reset() {
    this.currentSize = null;
    this.samples = [];
  }

  observe(size, elapsedMs) {
    const index = this.sizes.indexOf(size);
    if (index < 0 || !Number.isFinite(elapsedMs) || elapsedMs <= 0) return size;
    if (this.currentSize !== size) {
      this.currentSize = size;
      this.samples = [];
    }
    this.samples.push(elapsedMs);
    if (this.samples.length > this.window) this.samples.shift();
    if (this.samples.length < this.window) return size;

    // Median rather than mean: robust to the occasional long batch.
    const median = [...this.samples].sort((a, b) => a - b)[this.samples.length >> 1];
    if (median >= this.minimumMs && median <= this.maximumMs) return size;

    let next = size;
    if (median < this.minimumMs && index < this.sizes.length - 1) next = this.sizes[index + 1];
    if (median > this.maximumMs && index > 0) next = this.sizes[index - 1];
    if (next === size) return size;

    // Only step if the projected batch time at `next` is closer to the target.
    const projectedMs = median * next / size;
    if (Math.abs(projectedMs - this.targetMs) >= Math.abs(median - this.targetMs)) return size;

    this.reset();
    return next;
  }
}
