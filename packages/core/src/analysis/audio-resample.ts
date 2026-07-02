/**
 * Streaming linear-interpolation resampler (mono f32). Feed arbitrary-sized
 * chunks; output accumulates in fixed-size Float32Array blocks, so peak
 * memory is ~the output size (e.g. ~110MB for 30 minutes of 16 kHz mono)
 * instead of the full source-rate track.
 */
export class StreamingResampler {
  private blocks: Float32Array[] = [];
  private block = new Float32Array(1 << 20);
  private blockFill = 0;
  private srcPos = 0; // fractional read position within the *current* chunk
  private carry = 0; // last sample of the previous chunk

  /** ratio = sourceRate / targetRate */
  constructor(private readonly ratio: number) {}

  private emit(value: number) {
    if (this.blockFill === this.block.length) {
      this.blocks.push(this.block);
      this.block = new Float32Array(1 << 20);
      this.blockFill = 0;
    }
    this.block[this.blockFill] = value;
    this.blockFill += 1;
  }

  push(chunk: Float32Array) {
    if (chunk.length === 0) return;
    let pos = this.srcPos;
    // Positions in (-1, 0) interpolate between the carry sample and chunk[0].
    while (pos <= chunk.length - 1) {
      if (pos < 0) {
        const frac = pos + 1;
        this.emit(this.carry * (1 - frac) + chunk[0] * frac);
      } else {
        const i0 = Math.floor(pos);
        const i1 = Math.min(i0 + 1, chunk.length - 1);
        const frac = pos - i0;
        this.emit(chunk[i0] * (1 - frac) + chunk[i1] * frac);
      }
      pos += this.ratio;
    }
    // Rebase position relative to the start of the next chunk.
    this.srcPos = pos - chunk.length;
    this.carry = chunk[chunk.length - 1];
  }

  finish(): Float32Array {
    const total = this.blocks.length * (1 << 20) + this.blockFill;
    const out = new Float32Array(total);
    let offset = 0;
    for (const b of this.blocks) {
      out.set(b, offset);
      offset += b.length;
    }
    out.set(this.block.subarray(0, this.blockFill), offset);
    this.blocks = [];
    return out;
  }
}
