/**
 * NGP-TRAFFIC Routing Engine
 * Dijkstra shortest-path over Nagpur road network
 * Calculates dispatch ETAs between stations/officers and junctions
 */

function haversine(lat1, lon1, lat2, lon2) {
  var R = 6371000;
  var dLat = (lat2 - lat1) * Math.PI / 180;
  var dLon = (lon2 - lon1) * Math.PI / 180;
  var a = Math.sin(dLat/2)*Math.sin(dLat/2) + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)*Math.sin(dLon/2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// Build adjacency graph from junctions + road segments
function buildGraph(junctions, roadSegments) {
  var graph = {};
  // Initialize all junction nodes
  junctions.forEach(function(j) {
    graph[j.id] = { lat: j.lat, lng: j.lng, edges: [] };
  });
  // Connect junctions that are close (within 2km) via road network
  roadSegments.forEach(function(road) {
    for (var i = 0; i < road.points.length - 1; i++) {
      var p1 = road.points[i];
      var p2 = road.points[i + 1];
      // Find nearest junctions to these road points
      var j1 = findNearestJunction(junctions, p1[0], p1[1]);
      var j2 = findNearestJunction(junctions, p2[0], p2[1]);
      if (j1 && j2 && j1.id !== j2.id) {
        var dist = haversine(j1.lat, j1.lng, j2.lat, j2.lng);
        var speed = road.type === 'highway' ? 40 : 25; // km/h in city
        if (road.traffic === 'heavy') speed *= 0.7;
        var timeMins = (dist / 1000) / speed * 60;
        addEdge(graph, j1.id, j2.id, dist, timeMins, road.name);
        addEdge(graph, j2.id, j1.id, dist, timeMins, road.name);
      }
    }
  });
  // Also connect nearby junctions not on explicit road segments (implicit city roads)
  for (var i = 0; i < junctions.length; i++) {
    for (var k = i + 1; k < junctions.length; k++) {
      var dist = haversine(junctions[i].lat, junctions[i].lng, junctions[k].lat, junctions[k].lng);
      if (dist < 2000) {
        var hasEdge = graph[junctions[i].id].edges.some(function(e) { return e.to === junctions[k].id; });
        if (!hasEdge) {
          var timeMins = (dist / 1000) / 20 * 60; // 20 km/h city roads
          addEdge(graph, junctions[i].id, junctions[k].id, dist, timeMins, 'City Road');
          addEdge(graph, junctions[k].id, junctions[i].id, dist, timeMins, 'City Road');
        }
      }
    }
  }
  return graph;
}

function findNearestJunction(junctions, lat, lng) {
  var best = null, bestDist = Infinity;
  junctions.forEach(function(j) {
    var d = haversine(lat, lng, j.lat, j.lng);
    if (d < bestDist && d < 1500) { bestDist = d; best = j; }
  });
  return best;
}

function addEdge(graph, from, to, dist, timeMins, roadName) {
  var exists = graph[from].edges.some(function(e) { return e.to === to; });
  if (!exists) {
    graph[from].edges.push({ to: to, distance: Math.round(dist), time: Math.round(timeMins * 10) / 10, road: roadName });
  }
}

// Dijkstra shortest path
function dijkstra(graph, startId, endId) {
  var dist = {};
  var prev = {};
  var visited = {};
  var queue = [];
  Object.keys(graph).forEach(function(id) { dist[id] = Infinity; prev[id] = null; });
  dist[startId] = 0;
  queue.push({ id: startId, cost: 0 });
  while (queue.length > 0) {
    queue.sort(function(a, b) { return a.cost - b.cost; });
    var current = queue.shift();
    if (visited[current.id]) continue;
    visited[current.id] = true;
    if (current.id === endId) break;
    if (!graph[current.id]) continue;
    graph[current.id].edges.forEach(function(edge) {
      if (visited[edge.to]) return;
      var newDist = dist[current.id] + edge.time;
      if (newDist < dist[edge.to]) {
        dist[edge.to] = newDist;
        prev[edge.to] = { from: current.id, road: edge.road, distance: edge.distance };
        queue.push({ id: edge.to, cost: newDist });
      }
    });
  }
  // Reconstruct path
  if (dist[endId] === Infinity) return null;
  var path = [];
  var curr = endId;
  while (prev[curr]) {
    path.unshift({ junction: curr, road: prev[curr].road, distance: prev[curr].distance });
    curr = prev[curr].from;
  }
  path.unshift({ junction: startId, road: 'Start', distance: 0 });
  return {
    from: startId, to: endId,
    totalTime: Math.round(dist[endId] * 10) / 10,
    totalDistance: path.reduce(function(s, p) { return s + p.distance; }, 0),
    path: path
  };
}

// Find nearest station to a junction
function findNearestStation(stations, junctions, graph, targetJunctionId) {
  var results = [];
  stations.forEach(function(station) {
    // Find nearest junction to this station
    var nearestJ = findNearestJunction(junctions, station.lat, station.lng);
    if (!nearestJ) return;
    var route = dijkstra(graph, nearestJ.id, targetJunctionId);
    if (route) {
      results.push({
        station: station,
        route: route,
        eta: route.totalTime,
        distance: route.totalDistance
      });
    }
  });
  results.sort(function(a, b) { return a.eta - b.eta; });
  return results;
}

// Calculate ETA for an officer to reach a junction
function calcOfficerETA(officerStation, targetJunction, stations, junctions, graph) {
  var station = stations.find(function(s) { return s.id === officerStation; });
  if (!station) return null;
  var nearestJ = findNearestJunction(junctions, station.lat, station.lng);
  if (!nearestJ) return null;
  var targetJ = junctions.find(function(j) { return j.id === targetJunction; });
  if (!targetJ) return null;
  var nearestTarget = findNearestJunction(junctions, targetJ.lat, targetJ.lng);
  if (!nearestTarget) return null;
  return dijkstra(graph, nearestJ.id, nearestTarget.id);
}

module.exports = { buildGraph: buildGraph, dijkstra: dijkstra, findNearestStation: findNearestStation, calcOfficerETA: calcOfficerETA, haversine: haversine, findNearestJunction: findNearestJunction };