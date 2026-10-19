declare module 'd3-force-3d' {
  interface ForceNode3D {
    x?: number;
    y?: number;
    z?: number;
    val: number;
  }

  interface Force<N extends ForceNode3D> {
    (alpha: number): void;
    initialize?: (nodes: N[], ...args: any[]) => void;
    [key: string]: any;
  }

  interface CollisionForce<N extends ForceNode3D> extends Force<N> {
    radius(radius: number | ((node: N) => number)): this;
    strength(strength: number): this;
    iterations(iterations: number): this;
  }

  interface PositionForce<N extends ForceNode3D> extends Force<N> {
    strength(strength: number): this;
    x(x: number | ((node: N) => number)): this;
    y(y: number | ((node: N) => number)): this;
    z(z: number | ((node: N) => number)): this;
  }

  export function forceCollide<N extends ForceNode3D>(radius?: number | ((node: N) => number)): CollisionForce<N>;
  export function forceX<N extends ForceNode3D>(x?: number | ((node: N) => number)): PositionForce<N>;
  export function forceY<N extends ForceNode3D>(y?: number | ((node: N) => number)): PositionForce<N>;
  export function forceZ<N extends ForceNode3D>(z?: number | ((node: N) => number)): PositionForce<N>;
}
