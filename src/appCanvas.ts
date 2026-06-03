import { CLOSE_TOLERANCE, closeStroke } from './stroke';
import { dist, type Vec2 } from './math';

export type SilhouetteCompleteHandler = (closed: Vec2[]) => void;

/** 2D canvas for drawing the initial closed silhouette (once per session). */
export class AppCanvas {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private drawing = false;
  private points: Vec2[] = [];
  private onComplete: SilhouetteCompleteHandler;

  constructor(canvas: HTMLCanvasElement, onComplete: SilhouetteCompleteHandler) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D context unavailable');
    this.ctx = ctx;
    this.onComplete = onComplete;
    this.bindEvents();
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  setVisible(visible: boolean): void {
    this.canvas.classList.toggle('hidden', !visible);
    if (visible) this.resize();
  }

  clear(): void {
    this.points = [];
    this.drawing = false;
    this.redraw();
  }

  private bindEvents(): void {
    const getPos = (e: PointerEvent): Vec2 => {
      const rect = this.canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };

    this.canvas.addEventListener('pointerdown', (e) => {
      if (this.canvas.classList.contains('hidden')) return;
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
      this.points = [];
      this.onComplete(closed);
    };

    this.canvas.addEventListener('pointerup', finish);
    this.canvas.addEventListener('pointercancel', finish);
  }

  private resize(): void {
    const rect = this.canvas.parentElement?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.canvas.style.width = `${rect.width}px`;
    this.canvas.style.height = `${rect.height}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.redraw();
  }

  private redraw(): void {
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

    if (this.points.length < 2) return;

    this.ctx.lineCap = 'round';
    this.ctx.lineJoin = 'round';
    this.ctx.lineWidth = 3;
    this.ctx.strokeStyle = '#2d5a8e';
    this.ctx.beginPath();
    this.ctx.moveTo(this.points[0].x, this.points[0].y);
    for (let i = 1; i < this.points.length; i++) {
      this.ctx.lineTo(this.points[i].x, this.points[i].y);
    }
    this.ctx.stroke();

    this.ctx.fillStyle = '#2d5a8e';
    this.ctx.beginPath();
    this.ctx.arc(this.points[0].x, this.points[0].y, 5, 0, Math.PI * 2);
    this.ctx.fill();
  }
}
