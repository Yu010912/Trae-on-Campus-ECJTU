// Shared road graph for the full shared city dataset. Building it once keeps
// parking guidance and delivery routing on exactly the same OSM network.

import { RoadGraph } from './hubgraph.js';

let graph = null;

export function getCityGraph(hub) {
  if (graph) return graph;
  graph = new RoadGraph();
  graph.build(hub?.roads || []);
  return graph;
}
