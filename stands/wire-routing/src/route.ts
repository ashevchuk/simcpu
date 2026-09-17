/**
 * Stand re-exports the production escape-channel router so fixtures and
 * editor share one implementation.
 */
export {
  assignRibbonRails,
  channelRoutePenalty,
  escapePoint,
  routeEscapeChannel,
  simplifyChannelPath as simplifyOrthoPath,
} from '../../../src/ui/routeChannel.js';
export type { ChannelRouteRequest as RouteRequest } from '../../../src/ui/routeChannel.js';

import { routeEscapeChannel } from '../../../src/ui/routeChannel.js';
import type { Aabb, Point, RouteDir } from './types.js';
import { bendCount, pathHitsObstacles, pathLength, pathOverlapLength } from './score.js';

export interface RouteMetrics {
  path: Point[];
  length: number;
  bends: number;
  hits: boolean;
  overlap: number;
}

export function routeWithMetrics(req: {
  from: Point;
  to: Point;
  obstacles: Aabb[];
  startDir?: RouteDir | null;
  endDir?: RouteDir | null;
  avoidOverlap?: Point[][];
  grid?: number;
}): RouteMetrics {
  const path = routeEscapeChannel(req);
  return {
    path,
    length: pathLength(path),
    bends: bendCount(path),
    hits: pathHitsObstacles(path, req.obstacles),
    overlap: pathOverlapLength(path, req.avoidOverlap ?? []),
  };
}

/** Sequential fanout: each net sees prior paths as avoidOverlap. */
export function routeNetsSequential(
  nets: Array<{
    from: Point;
    to: Point;
    startDir?: RouteDir | null;
    endDir?: RouteDir | null;
  }>,
  obstacles: Aabb[],
  grid = 10,
): Point[][] {
  const drawn: Point[][] = [];
  for (const net of nets) {
    const path = routeEscapeChannel({
      from: net.from,
      to: net.to,
      startDir: net.startDir,
      endDir: net.endDir,
      obstacles,
      avoidOverlap: drawn,
      grid,
    });
    drawn.push(path);
  }
  return drawn;
}
