import type { ProjectData } from '../model/types';

/**
 * 特征身份分配器：所有新点/边/记号的 id 都从工程单调 seq 派生。
 * seq 写入 ProjectData 并随版本快照一起保存，撤销/重做后绝不复用旧号，
 * 因此同一个省尖/剪切交点在转移前后是同一个 id，重新离散不会改绑。
 */
export class IdGen {
  constructor(private data: ProjectData) {}

  private next(prefix: string): string {
    this.data.seq += 1;
    return `${prefix}${this.data.seq}`;
  }

  point(): string {
    return this.next('p');
  }
  edge(): string {
    return this.next('e');
  }
  notch(): string {
    return this.next('n');
  }
  dart(): string {
    return this.next('d');
  }
  slash(): string {
    return this.next('s');
  }
  piece(): string {
    return this.next('pc');
  }
}

/** 扫描现有 id 中的最大序号（用于从外部加载数据后的防御性对齐）。 */
export function reconcileSeq(data: ProjectData): void {
  let max = data.seq;
  const consider = (id: string) => {
    const m = /^[a-z]+(\d+)$/.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  };
  Object.keys(data.points).forEach(consider);
  Object.keys(data.edges).forEach(consider);
  Object.keys(data.notches).forEach(consider);
  Object.keys(data.darts).forEach(consider);
  Object.keys(data.slashes).forEach(consider);
  Object.keys(data.pieces).forEach(consider);
  data.seq = max;
}
