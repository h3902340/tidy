import { CLOSE_TOLERANCE, closeStroke } from './stroke';
import { dist, type Vec2 } from './math';

export type StrokeCompleteHandler = (points: Vec2[], closed: Vec2[]) => void;

export class DrawCanvas {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private drawing = false;
  private points: Vec2[] = [];
  private onComplete: StrokeCompleteHandler;

  constructor(canvas: HTMLCanvasElement, onComplete: StrokeCompleteHandler) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D context unavailable');
    this.ctx = ctx;
    this.onComplete = onComplete;
    this.bindEvents();
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  private resize(): void {
    const rect = this.canvas.parentElement?.getBoundingClientRect();
    if (!rect) return;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.canvas.style.width = `${rect.width}px`;
    this.canvas.style.height = `${rect.height}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.redraw();
  }

  private bindEvents(): void {
    const getPos = (e: PointerEvent): Vec2 => {
      const rect = this.canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };

    this.canvas.addEventListener('pointerdown', (e) => {
      this.canvas.setPointerCapture(e.pointerId);
      this.drawing = true;
      this.points = [getPos(e)];
      this.redraw();
    });

    this.canvas.addEventListener('pointermove', (e) => {
      if (!this.drawing) return;
      const p = getPos(e);
      const last = this.points[this.points.length - 1];
      if (dist(p, last) > 2) {
        this.points.push(p);
        this.redraw();
      }
    });

    const finish = () => {
      if (!this.drawing) return;
      this.drawing = false;
      if (this.points.length < 3) {
        this.points = [];
        this.redraw();
        return;
      }
      const closed = closeStroke(this.points, CLOSE_TOLERANCE);
      this.onComplete(this.points, closed);
      this.redraw(closed);
    };

    this.canvas.addEventListener('pointerup', finish);
    this.canvas.addEventListener('pointercancel', finish);
  }

  clear(): void {
    this.points = [];
    this.redraw();
  }

  /** Show a closed stroke without firing onComplete. */
  setClosedStroke(closed: Vec2[]): void {
    this.points = closed.slice(0, -1);
    this.redraw(closed);
  }

  private redraw(previewClosed?: Vec2[]): void {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.ctx.clearRect(0, 0, w, h);

    this.ctx.fillStyle = '#faf9f7';
    this.ctx.fillRect(0, 0, w, h);

    this.ctx.strokeStyle = '#c8c4bc';
    this.ctx.lineWidth = 1;
    this.ctx.setLineDash([4, 6]);
    this.ctx.strokeRect(24, 24, w - 48, h - 48);
    this.ctx.setLineDash([]);

    const stroke = previewClosed ?? this.points;
    if (stroke.length < 2) return;

    this.ctx.lineCap = 'round';
    this.ctx.lineJoin = 'round';
    this.ctx.lineWidth = 3;
    this.ctx.strokeStyle = '#2d5a8e';

    this.ctx.beginPath();
    this.ctx.moveTo(stroke[0].x, stroke[0].y);
    for (let i = 1; i < stroke.length; i++) {
      this.ctx.lineTo(stroke[i].x, stroke[i].y);
    }
    this.ctx.stroke();

    if (previewClosed && previewClosed.length > 1) {
      const first = previewClosed[0];
      const last = previewClosed[previewClosed.length - 1];
      const gap = dist(first, last);
      if (gap > 1) {
        this.ctx.setLineDash([6, 4]);
        this.ctx.strokeStyle = '#8b7355';
        this.ctx.lineWidth = 2;
        this.ctx.beginPath();
        this.ctx.moveTo(last.x, last.y);
        this.ctx.lineTo(first.x, first.y);
        this.ctx.stroke();
        this.ctx.setLineDash([]);
      }
    }

    this.ctx.fillStyle = '#2d5a8e';
    this.ctx.beginPath();
    this.ctx.arc(stroke[0].x, stroke[0].y, 5, 0, Math.PI * 2);
    this.ctx.fill();
  }
}
