import { describe, it, expect, vi } from 'vitest';
import { ClipperClient } from './client';
import type { WorkerRequest, WorkerResponse } from './protocol';

function fakeWorker(): { worker: Worker; deliver: (m: WorkerResponse) => void; sent: WorkerRequest[] } {
  const sent: WorkerRequest[] = [];
  let handler: ((ev: MessageEvent) => void) | null = null;
  const worker = {
    postMessage: (m: WorkerRequest) => sent.push(m),
    set onmessage(fn: ((ev: MessageEvent) => void) | null) { handler = fn; },
    get onmessage() { return handler as never; },
    terminate: vi.fn(),
    onerror: null as ((ev: ErrorEvent) => void) | null,
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return false; },
  } as unknown as Worker;
  return {
    worker,
    sent,
    deliver: (m: WorkerResponse) => handler?.({ data: m } as MessageEvent),
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const tri = [[{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]];

describe('ClipperClient 代次核对：迟到结果不得覆盖新几何', () => {
  it('用户继续编辑后，旧代次回包被拒绝，当前几何不被覆盖', async () => {
    const fw = fakeWorker();
    const client = new ClipperClient(() => fw.worker);
    fw.deliver({ type: 'ready' });

    const p1 = client.offset({ gen: 1, fingerprint: 'fp1', polygons: tri, deltaMm: 2 });
    await tick();
    const req1 = fw.sent.find((m) => m.type === 'offset')!;
    expect(req1.gen).toBe(1);

    // 用户继续编辑：提交 gen=2 新任务
    const p2 = client.offset({ gen: 2, fingerprint: 'fp2', polygons: tri, deltaMm: 2 });
    await tick();
    const req2 = fw.sent.filter((m) => m.type === 'offset')[1];
    expect(req2.gen).toBe(2);

    // gen=1 的迟到回包此时才到达
    fw.deliver({ type: 'offset-result', jobId: req1.jobId, gen: 1, fingerprint: 'fp1', ms: 5, outer: [[{ x: -99, y: -99 }]], holes: [] });
    await expect(p1).rejects.toMatchObject({ code: 'STALE_RESULT' });

    // gen=2 的结果正常兑现
    fw.deliver({ type: 'offset-result', jobId: req2.jobId, gen: 2, fingerprint: 'fp2', ms: 6, outer: [[{ x: 0, y: 0 }, { x: 1, y: 0 }]], holes: [] });
    const got = await p2;
    expect(got.outer[0][0]).toEqual({ x: 0, y: 0 });
  });

  it('取消后迟到回包被拒绝（STALE_RESULT），几何不被覆盖', async () => {
    const fw = fakeWorker();
    const client = new ClipperClient(() => fw.worker);
    fw.deliver({ type: 'ready' });

    const p1 = client.offset({ gen: 1, fingerprint: 'gx', polygons: tri, deltaMm: 1 });
    await tick();
    const req1 = fw.sent.find((m) => m.type === 'offset')!;
    client.cancel(req1.jobId);

    fw.deliver({ type: 'offset-result', jobId: req1.jobId, gen: 1, fingerprint: 'gx', ms: 9, outer: [[{ x: 0, y: 0 }]], holes: [] });
    await expect(p1).rejects.toMatchObject({ code: 'STALE_RESULT' });
  });

  it('worker 自身以 CANCELLED 回复时也被安全拒绝', async () => {
    const fw = fakeWorker();
    const client = new ClipperClient(() => fw.worker);
    fw.deliver({ type: 'ready' });
    const p1 = client.offset({ gen: 1, fingerprint: 'gy', polygons: tri, deltaMm: 1 });
    await tick();
    const req1 = fw.sent.find((m) => m.type === 'offset')!;
    fw.deliver({ type: 'error', jobId: req1.jobId, gen: 1, fingerprint: 'gy', ms: 0, code: 'CANCELLED', cancelled: true, message: '任务已取消' });
    await expect(p1).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});
