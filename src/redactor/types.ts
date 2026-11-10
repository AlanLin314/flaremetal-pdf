export type UserRect = { x: number; y: number; w: number; h: number };

export type CssRect = { x: number; y: number; w: number; h: number };

export type Redaction = {
  id: string;
  page: number;
  rect: UserRect;
  color: string;
};

export type PageMetrics = {
  /** Visual width in PDF points, or image pixels. */
  width: number;
  /** Visual height in PDF points, or image pixels. */
  height: number;
  rotation: 0 | 90 | 180 | 270;
};

export type Dpi = 150 | 200 | 300;

export const DPI_CHOICES: Dpi[] = [150, 200, 300];
export const DEFAULT_DPI: Dpi = 200;
