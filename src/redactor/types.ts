export type UserRect = { x: number; y: number; w: number; h: number };

export type UserPoint = { x: number; y: number };

export type CssRect = { x: number; y: number; w: number; h: number };

export type RectMark = {
  kind: "rect";
  id: string;
  page: number;
  rect: UserRect;
  color: string;
};

/** Brush stroke in unrotated PDF user space. `width` is in the same units. */
export type StrokeMark = {
  kind: "stroke";
  id: string;
  page: number;
  color: string;
  width: number;
  points: UserPoint[];
};

export type Redaction = RectMark | StrokeMark;

export type HistoryState = {
  redactions: Redaction[];
  rotations: number[];
};

export type PageMetrics = {
  /** Visual width in PDF points, or image pixels, after rotation. */
  width: number;
  /** Visual height in PDF points, or image pixels, after rotation. */
  height: number;
  /** Total clockwise display rotation. */
  rotation: 0 | 90 | 180 | 270;
  /** Unrotated page width. Brush points live in this space. */
  sourceWidth: number;
  /** Unrotated page height. */
  sourceHeight: number;
};

export type Dpi = 150 | 200 | 300;

export const DPI_CHOICES: Dpi[] = [150, 200, 300];
export const DEFAULT_DPI: Dpi = 200;
