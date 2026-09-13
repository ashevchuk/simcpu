// Minimal union-find (disjoint set) over string keys, used to group pins
// into electrical nets.
export class UnionFind {
  private parent = new Map<string, string>();

  private root(x: string): string {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let r = x;
    while (this.parent.get(r) !== r) r = this.parent.get(r) as string;
    // path compression
    let cur = x;
    while (this.parent.get(cur) !== r) {
      const next = this.parent.get(cur) as string;
      this.parent.set(cur, r);
      cur = next;
    }
    return r;
  }

  union(a: string, b: string): void {
    const ra = this.root(a);
    const rb = this.root(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }

  find(x: string): string {
    return this.root(x);
  }

  groups(): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const key of this.parent.keys()) {
      const r = this.root(key);
      const list = out.get(r);
      if (list) list.push(key);
      else out.set(r, [key]);
    }
    return out;
  }
}
