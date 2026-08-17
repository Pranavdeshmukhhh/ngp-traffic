/**
 * NGP-TRAFFIC ML Risk Prediction Engine
 * Random Forest ensemble - pure JavaScript
 * Trained on synthetic Nagpur junction feature data
 */

var FEATURE_NAMES = ['hour','day_of_week','rain_mm','road_type_enc','accident_rate_norm','speed_limit','school_zone','hospital_zone','ped_density_enc','lane_count','has_signal','traffic_vol_norm','incident_weight'];
var ROAD_TYPE_MAP = { major_intersection: 5, highway_entry: 4, school_zone: 4.5, commercial: 3, landmark_junction: 2.5, minor: 1 };
var PED_DENSITY_MAP = { high: 3, medium: 2, low: 1 };

function extractFeatures(junction, hour, dayOfWeek, rainMM, incidentWeight) {
  var hourVol = junction.trafficByHour[hour] || 0;
  var maxVol = Math.max.apply(null, junction.trafficByHour);
  return [
    hour / 23, dayOfWeek / 6, Math.min(rainMM, 50) / 50,
    (ROAD_TYPE_MAP[junction.roadType] || 2) / 5,
    Math.min(junction.accidentHistory, 30) / 30,
    junction.laneCount >= 4 ? (junction.laneCount >= 6 ? 0.3 : 0.5) : 0.8,
    junction.nearSchool ? 1 : 0, junction.nearHospital ? 1 : 0,
    (PED_DENSITY_MAP[junction.pedestrianDensity] || 1) / 3,
    junction.laneCount / 8, junction.hasSignal ? 1 : 0,
    hourVol / (maxVol || 1), Math.min(incidentWeight, 1)
  ];
}

function computeLabel(features) {
  var hour = features[0] * 23, rain = features[2] * 50;
  var accNorm = features[4], trafficNorm = features[11], roadEnc = features[3];
  var pedEnc = features[8], schoolZone = features[6], hospitalZone = features[7], incidentW = features[12];
  var peakMult = ((hour >= 8 && hour <= 10) || (hour >= 17 && hour <= 19)) ? 1.35 : (hour >= 22 || hour <= 5) ? 0.6 : (hour >= 6 && hour <= 7) ? 0.9 : 1.0;
  var rainMult = 1.0 + (rain / 50) * 0.4;
  var dowMult = features[1] > 0.7 ? 0.85 : 1.0;
  var base = 0.30*accNorm + 0.25*trafficNorm*peakMult + 0.15*roadEnc + 0.10*pedEnc + 0.05*(schoolZone*0.6 + hospitalZone*0.4) + 0.10*incidentW;
  var score = base * rainMult * dowMult * 100;
  var noise = Math.sin(hour * 7 + accNorm * 13 + trafficNorm * 19) * 3;
  return Math.max(0, Math.min(100, Math.round(score + noise)));
}

// --- Fast Decision Stump Forest (optimized for startup speed) ---
function Stump(featureIdx, threshold, leftVal, rightVal) {
  this.f = featureIdx; this.t = threshold; this.l = leftVal; this.r = rightVal;
}

function buildStump(data, featureIdx) {
  var vals = data.map(function(d) { return d.features[featureIdx]; });
  var median = vals.sort(function(a,b){return a-b;})[Math.floor(vals.length/2)];
  var leftSum = 0, leftN = 0, rightSum = 0, rightN = 0;
  data.forEach(function(d) {
    if (d.features[featureIdx] <= median) { leftSum += d.label; leftN++; }
    else { rightSum += d.label; rightN++; }
  });
  return new Stump(featureIdx, median, leftN > 0 ? leftSum/leftN : 50, rightN > 0 ? rightSum/rightN : 50);
}

// Gradient Boosted Stumps - fast to train, still a real ML model
function GBForest() {
  this.stumps = [];
  this.learningRate = 0.15;
  this.metrics = null;
  this.featureImportance = null;
}

GBForest.prototype.train = function(junctions) {
  console.log('  [ML] Generating training data...');
  var data = [];
  junctions.forEach(function(j) {
    [0,3,6,9,12,15,18,21].forEach(function(h) {
      [1,5].forEach(function(dow) {
        var features = extractFeatures(j, h, dow, 0, 0);
        data.push({ features: features, label: computeLabel(features) });
        var featR = extractFeatures(j, h, dow, 10, 0);
        data.push({ features: featR, label: computeLabel(featR) });
      });
    });
  });

  // Shuffle
  for (var i = data.length - 1; i > 0; i--) {
    var k = Math.floor(Math.abs(Math.sin(i * 9301) * 233280) % (i + 1));
    var tmp = data[i]; data[i] = data[k]; data[k] = tmp;
  }

  var splitIdx = Math.floor(data.length * 0.8);
  var trainData = data.slice(0, splitIdx);
  var testData = data.slice(splitIdx);
  console.log('  [ML] Training: ' + trainData.length + ' samples, Test: ' + testData.length + ' samples');

  // Initialize residuals
  var mean = trainData.reduce(function(s,d){return s+d.label;},0) / trainData.length;
  this.basePrediction = mean;
  var residuals = trainData.map(function(d) { return d.label - mean; });

  // Build 50 boosted stumps (very fast)
  var numRounds = 50;
  var nFeatures = FEATURE_NAMES.length;
  for (var round = 0; round < numRounds; round++) {
    // Find best feature for this round
    var bestStump = null, bestMSE = Infinity;
    for (var fi = 0; fi < nFeatures; fi++) {
      var residData = trainData.map(function(d, i) { return { features: d.features, label: residuals[i] }; });
      var stump = buildStump(residData, fi);
      var mse = 0;
      residData.forEach(function(d) {
        var pred = d.features[stump.f] <= stump.t ? stump.l : stump.r;
        mse += Math.pow(d.label - pred, 2);
      });
      if (mse < bestMSE) { bestMSE = mse; bestStump = stump; }
    }
    this.stumps.push(bestStump);
    // Update residuals
    var lr = this.learningRate;
    residuals = residuals.map(function(r, i) {
      var pred = trainData[i].features[bestStump.f] <= bestStump.t ? bestStump.l : bestStump.r;
      return r - lr * pred;
    });
  }
  console.log('  [ML] Trained ' + numRounds + ' gradient boosted stumps');

  this.metrics = this._evaluate(testData);
  this.featureImportance = this._calcImportance();
  console.log('  [ML] R\u00b2=' + this.metrics.r2.toFixed(4) + ' RMSE=' + this.metrics.rmse.toFixed(2) + ' Accuracy=' + (this.metrics.accuracy * 100).toFixed(1) + '%');
};

GBForest.prototype.predict = function(features) {
  var pred = this.basePrediction;
  var lr = this.learningRate;
  this.stumps.forEach(function(s) {
    pred += lr * (features[s.f] <= s.t ? s.l : s.r);
  });
  return Math.max(0, Math.min(100, Math.round(pred)));
};

GBForest.prototype._evaluate = function(testData) {
  var self = this;
  var preds = testData.map(function(d) { return self.predict(d.features); });
  var acts = testData.map(function(d) { return d.label; });
  var mse = preds.reduce(function(s,p,i){return s+Math.pow(p-acts[i],2);},0) / preds.length;
  var rmse = Math.sqrt(mse);
  var meanA = acts.reduce(function(s,a){return s+a;},0) / acts.length;
  var ssTot = acts.reduce(function(s,a){return s+Math.pow(a-meanA,2);},0);
  var ssRes = preds.reduce(function(s,p,i){return s+Math.pow(acts[i]-p,2);},0);
  var r2 = 1 - ssRes / ssTot;
  var correct = 0;
  for (var i = 0; i < preds.length; i++) {
    var pL = preds[i]>=70?'high':preds[i]>=40?'medium':'low';
    var aL = acts[i]>=70?'high':acts[i]>=40?'medium':'low';
    if (pL === aL) correct++;
  }
  var accuracy = correct / preds.length;
  var classes = ['high','medium','low'], f1s = {};
  classes.forEach(function(cls) {
    var tp=0,fp=0,fn=0;
    for (var i=0;i<preds.length;i++) {
      var pL=preds[i]>=70?'high':preds[i]>=40?'medium':'low';
      var aL=acts[i]>=70?'high':acts[i]>=40?'medium':'low';
      if(pL===cls&&aL===cls)tp++; else if(pL===cls)fp++; else if(aL===cls)fn++;
    }
    var pr=tp/(tp+fp||1),re=tp/(tp+fn||1);
    f1s[cls]=2*pr*re/(pr+re||1);
  });
  var macroF1 = (f1s.high+f1s.medium+f1s.low)/3;
  var pvaCurve = [];
  var step = Math.max(1, Math.floor(testData.length/50));
  for (var i=0; i<testData.length && pvaCurve.length<50; i+=step) pvaCurve.push({predicted:preds[i],actual:acts[i]});
  return { r2:r2, rmse:rmse, accuracy:accuracy, macroF1:macroF1, f1PerClass:f1s, sampleSize:testData.length, trainSize:Math.floor(testData.length*4), pvaCurve:pvaCurve, mse:mse };
};

GBForest.prototype._calcImportance = function() {
  var counts = {};
  FEATURE_NAMES.forEach(function(f){counts[f]=0;});
  this.stumps.forEach(function(s) {
    var name = FEATURE_NAMES[s.f];
    var spread = Math.abs(s.l - s.r);
    counts[name] += spread;
  });
  var total = Object.values(counts).reduce(function(s,v){return s+v;},0);
  Object.keys(counts).forEach(function(k){counts[k]=Math.round(counts[k]/(total||1)*1000)/1000;});
  return counts;
};

// Export as RandomForest for backward compatibility
module.exports = { RandomForest: GBForest, extractFeatures: extractFeatures, FEATURE_NAMES: FEATURE_NAMES, ROAD_TYPE_MAP: ROAD_TYPE_MAP, PED_DENSITY_MAP: PED_DENSITY_MAP };