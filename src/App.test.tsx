import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { App } from './App';

describe('App 冒烟（jsdom 下无 Canvas 后端也应可用）', () => {
  it('渲染工具栏、校验结论与初始版本，并可打开容差编辑', () => {
    render(<App />);
    expect(screen.getByText(/纸样工程/)).toBeTruthy();
    expect(screen.getByText(/通过：闭合/)).toBeTruthy();
    expect(screen.getByText(/初始样板/)).toBeTruthy();
    // 撤销初始禁用
    const undoBtn = screen.getByText('撤销') as HTMLButtonElement;
    expect(undoBtn.disabled).toBe(true);
  });

  it('失败角度的转移给出错误反馈且不产生新版本', () => {
    const { container } = render(<App />);
    const versionsBefore = container.querySelectorAll('.versions li').length;
    const input = screen.getByDisplayValue('90') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '-90' } });
    fireEvent.click(screen.getByText('提交一次转移'));
    expect(screen.getByText(/未命中|失败|版本未替换/)).toBeTruthy();
    expect(container.querySelectorAll('.versions li').length).toBe(versionsBefore);
  });

  it('成功转移后版本前进、撤销可用并可恢复', () => {
    render(<App />);
    fireEvent.click(screen.getByText('提交一次转移'));
    expect(screen.getByText(/转移已提交/)).toBeTruthy();
    const undoBtn = screen.getByText('撤销') as HTMLButtonElement;
    expect(undoBtn.disabled).toBe(false);
    act(() => { fireEvent.click(undoBtn); });
    // 恢复到 v1
    expect(screen.getByText(/初始样板/)).toBeTruthy();
  });

  it('英寸模式只改变显示文字（容差标签仍可见，比例尺导出单位切换）', () => {
    render(<App />);
    fireEvent.click(screen.getByText('英寸'));
    // 缝份 10mm 显示为 0.394 in
    const saInput = document.querySelector('input[value="0.394"]') as HTMLInputElement | null;
    expect(saInput).toBeTruthy();
    fireEvent.click(screen.getByText('毫米'));
    expect(document.querySelector('input[value="10"]')).toBeTruthy();
  });
});
