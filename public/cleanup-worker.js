/* FlareMetal document cleanup. Runs OpenCV.js off the main thread. */
var ready = false;
var queue = [];
var cvRef = null;

self.Module = {
  onRuntimeInitialized: function () {
    markReady();
  },
};

function markReady() {
  if (ready) return;
  cvRef = self.cv;
  if (!cvRef || typeof cvRef.Mat !== "function") return;
  ready = true;
  self.postMessage({ type: "ready" });
  var pending = queue;
  queue = [];
  for (var i = 0; i < pending.length; i += 1) handle(pending[i]);
}

try {
  importScripts("opencv/opencv.js");
} catch (err) {
  self.postMessage({ type: "fatal", message: "無法載入 OpenCV。" });
}

setInterval(function () {
  if (!ready && self.cv && typeof self.cv.Mat === "function") markReady();
}, 40);

self.onmessage = function (event) {
  if (!ready) queue.push(event.data);
  else handle(event.data);
};

function handle(message) {
  if (!message || message.type !== "process") return;
  try {
    var result = processFrame(message);
    self.postMessage(
      {
        type: "result",
        id: message.id,
        width: result.width,
        height: result.height,
        buffer: result.buffer,
        corners: result.corners,
        foundQuad: result.foundQuad,
        angle: result.angle,
      },
      [result.buffer],
    );
  } catch (err) {
    self.postMessage({
      type: "error",
      id: message.id,
      message: err && err.message ? err.message : "整理失敗。",
    });
  }
}

function drop(mats) {
  for (var i = 0; i < mats.length; i += 1) {
    try {
      if (mats[i] && !mats[i].isDeleted()) mats[i].delete();
    } catch (err) {
      /* already gone */
    }
  }
}

function matFromRgba(width, height, buffer) {
  var mat = new cvRef.Mat(height, width, cvRef.CV_8UC4);
  mat.data.set(new Uint8Array(buffer));
  return mat;
}

function cloneToBuffer(mat) {
  var copy = new Uint8Array(mat.cols * mat.rows * 4);
  copy.set(mat.data);
  return copy.buffer;
}

function resizeMax(src, maxEdge) {
  var edge = Math.max(src.cols, src.rows);
  if (edge <= maxEdge) return src.clone();
  var scale = maxEdge / edge;
  var dst = new cvRef.Mat();
  cvRef.resize(
    src,
    dst,
    new cvRef.Size(Math.max(1, Math.round(src.cols * scale)), Math.max(1, Math.round(src.rows * scale))),
    0,
    0,
    cvRef.INTER_AREA,
  );
  return dst;
}

function orderQuad(pts) {
  var sums = pts.map(function (p) {
    return p.x + p.y;
  });
  var diffs = pts.map(function (p) {
    return p.y - p.x;
  });
  function at(values, want) {
    var index = 0;
    for (var i = 1; i < values.length; i += 1) {
      if (want === "min" ? values[i] < values[index] : values[i] > values[index]) index = i;
    }
    return pts[index];
  }
  return [at(sums, "min"), at(diffs, "min"), at(sums, "max"), at(diffs, "max")];
}

function imageCorners(mat) {
  return [
    { x: 0, y: 0 },
    { x: mat.cols - 1, y: 0 },
    { x: mat.cols - 1, y: mat.rows - 1 },
    { x: 0, y: mat.rows - 1 },
  ];
}

function readPoint(approx, index) {
  return { x: approx.data32S[index * 2], y: approx.data32S[index * 2 + 1] };
}

function findQuad(src) {
  var gray = new cvRef.Mat();
  var blur = new cvRef.Mat();
  var edges = new cvRef.Mat();
  var kernel = cvRef.getStructuringElement(cvRef.MORPH_RECT, new cvRef.Size(5, 5));
  var contours = new cvRef.MatVector();
  var hierarchy = new cvRef.Mat();
  var best = null;
  var bestArea = 0;
  try {
    cvRef.cvtColor(src, gray, cvRef.COLOR_RGBA2GRAY);
    cvRef.GaussianBlur(gray, blur, new cvRef.Size(5, 5), 0);
    cvRef.Canny(blur, edges, 40, 130);
    cvRef.dilate(edges, edges, kernel);
    cvRef.findContours(edges, contours, hierarchy, cvRef.RETR_LIST, cvRef.CHAIN_APPROX_SIMPLE);
    var imgArea = src.cols * src.rows;
    for (var i = 0; i < contours.size(); i += 1) {
      var cnt = contours.get(i);
      var area = cvRef.contourArea(cnt);
      if (area < imgArea * 0.18) {
        cnt.delete();
        continue;
      }
      var peri = cvRef.arcLength(cnt, true);
      var approx = new cvRef.Mat();
      cvRef.approxPolyDP(cnt, approx, 0.02 * peri, true);
      cnt.delete();
      if (approx.rows === 4 && cvRef.isContourConvex(approx) && area > bestArea) {
        if (best) best.delete();
        best = approx;
        bestArea = area;
      } else {
        approx.delete();
      }
    }
    if (!best) return { corners: imageCorners(src), found: false };
    var pts = [];
    for (var p = 0; p < 4; p += 1) pts.push(readPoint(best, p));
    return { corners: orderQuad(pts), found: true };
  } finally {
    drop([gray, blur, edges, kernel, hierarchy, best]);
    contours.delete();
  }
}

function warpQuad(src, corners) {
  var tl = corners[0];
  var tr = corners[1];
  var br = corners[2];
  var bl = corners[3];
  var width = Math.max(Math.hypot(br.x - bl.x, br.y - bl.y), Math.hypot(tr.x - tl.x, tr.y - tl.y));
  var height = Math.max(Math.hypot(tr.x - br.x, tr.y - br.y), Math.hypot(tl.x - bl.x, tl.y - bl.y));
  var w = Math.max(2, Math.round(width));
  var h = Math.max(2, Math.round(height));
  var srcPts = cvRef.matFromArray(4, 1, cvRef.CV_32FC2, [tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y]);
  var dstPts = cvRef.matFromArray(4, 1, cvRef.CV_32FC2, [0, 0, w - 1, 0, w - 1, h - 1, 0, h - 1]);
  var transform = cvRef.getPerspectiveTransform(srcPts, dstPts);
  var dst = new cvRef.Mat();
  cvRef.warpPerspective(
    src,
    dst,
    transform,
    new cvRef.Size(w, h),
    cvRef.INTER_LINEAR,
    cvRef.BORDER_CONSTANT,
    new cvRef.Scalar(255, 255, 255, 255),
  );
  drop([srcPts, dstPts, transform]);
  return dst;
}

function rotateRgba(src, angle) {
  if (Math.abs(angle) < 0.15) return src.clone();
  var matrix = cvRef.getRotationMatrix2D(new cvRef.Point(src.cols / 2, src.rows / 2), angle, 1);
  var dst = new cvRef.Mat();
  cvRef.warpAffine(
    src,
    dst,
    matrix,
    new cvRef.Size(src.cols, src.rows),
    cvRef.INTER_LINEAR,
    cvRef.BORDER_CONSTANT,
    new cvRef.Scalar(255, 255, 255, 255),
  );
  matrix.delete();
  return dst;
}

function projectionScore(gray) {
  var reduced = new cvRef.Mat();
  cvRef.reduce(gray, reduced, 1, cvRef.REDUCE_AVG, cvRef.CV_32F);
  var data = reduced.data32F;
  var mean = 0;
  for (var i = 0; i < data.length; i += 1) mean += data[i];
  mean /= data.length || 1;
  var variance = 0;
  for (var j = 0; j < data.length; j += 1) {
    var delta = data[j] - mean;
    variance += delta * delta;
  }
  reduced.delete();
  return variance;
}

function scoreAngle(gray, angle) {
  var matrix = cvRef.getRotationMatrix2D(new cvRef.Point(gray.cols / 2, gray.rows / 2), angle, 1);
  var rotated = new cvRef.Mat();
  cvRef.warpAffine(gray, rotated, matrix, new cvRef.Size(gray.cols, gray.rows), cvRef.INTER_LINEAR, cvRef.BORDER_CONSTANT, new cvRef.Scalar(255));
  var score = projectionScore(rotated);
  drop([matrix, rotated]);
  return score;
}

function deskewAngle(src) {
  var gray = new cvRef.Mat();
  var small = null;
  try {
    cvRef.cvtColor(src, gray, cvRef.COLOR_RGBA2GRAY);
    small = resizeMax(gray, 420);
    var best = 0;
    var bestScore = -1;
    for (var angle = -15; angle <= 15.001; angle += 1) {
      var score = scoreAngle(small, angle);
      if (score > bestScore) {
        bestScore = score;
        best = angle;
      }
    }
    for (var fine = best - 1; fine <= best + 1.001; fine += 0.25) {
      var fineScore = scoreAngle(small, fine);
      if (fineScore > bestScore) {
        bestScore = fineScore;
        best = fine;
      }
    }
    return Math.abs(best) < 0.2 ? 0 : best;
  } finally {
    drop([gray, small]);
  }
}

function oddKernel(size) {
  var k = Math.max(3, Math.round(size));
  if (k % 2 === 0) k += 1;
  return k;
}

function whiten(src, strength) {
  var gray = new cvRef.Mat();
  var kernel = null;
  var bg = new cvRef.Mat();
  var grayF = new cvRef.Mat();
  var bgF = new cvRef.Mat();
  var norm = new cvRef.Mat();
  var outGray = new cvRef.Mat();
  var blurred = new cvRef.Mat();
  var specks = new cvRef.Mat();
  var labels = new cvRef.Mat();
  var stats = new cvRef.Mat();
  var centroids = new cvRef.Mat();
  var rgba = new cvRef.Mat();
  try {
    cvRef.cvtColor(src, gray, cvRef.COLOR_RGBA2GRAY);
    var closeSize = strength === "light" ? 31 : strength === "strong" ? 91 : 61;
    closeSize = oddKernel(Math.min(closeSize, Math.round(Math.min(src.cols, src.rows) * 0.18)));
    kernel = cvRef.getStructuringElement(cvRef.MORPH_ELLIPSE, new cvRef.Size(closeSize, closeSize));
    cvRef.morphologyEx(gray, bg, cvRef.MORPH_CLOSE, kernel);
    gray.convertTo(grayF, cvRef.CV_32F);
    bg.convertTo(bgF, cvRef.CV_32F, 1, 1);
    cvRef.divide(grayF, bgF, norm, 255);
    norm.convertTo(outGray, cvRef.CV_8U);
    var med = strength === "light" ? 3 : 5;
    cvRef.medianBlur(outGray, blurred, med);
    var maxArea = strength === "light" ? 10 : strength === "strong" ? 36 : 18;
    cvRef.threshold(blurred, specks, 246, 255, cvRef.THRESH_BINARY_INV);
    var count = cvRef.connectedComponentsWithStats(specks, labels, stats, centroids, 8, cvRef.CV_32S);
    if (count > 1 && count < 700) {
      for (var label = 1; label < count; label += 1) {
        var area = stats.intAt(label, cvRef.CC_STAT_AREA);
        if (area <= 0 || area > maxArea) continue;
        var mask = new cvRef.Mat();
        var probe = new cvRef.Mat(labels.rows, labels.cols, labels.type(), new cvRef.Scalar(label));
        cvRef.compare(labels, probe, mask, cvRef.CMP_EQ);
        blurred.setTo(new cvRef.Scalar(255), mask);
        drop([mask, probe]);
      }
    }
    cvRef.cvtColor(blurred, rgba, cvRef.COLOR_GRAY2RGBA);
    return rgba;
  } finally {
    drop([gray, kernel, bg, grayF, bgF, norm, outGray, blurred, specks, labels, stats, centroids]);
  }
}

function binarize(src, threshold) {
  var gray = new cvRef.Mat();
  var bw = new cvRef.Mat();
  var rgba = new cvRef.Mat();
  try {
    cvRef.cvtColor(src, gray, cvRef.COLOR_RGBA2GRAY);
    var block = oddKernel(Math.min(41, Math.max(15, Math.round(Math.min(src.cols, src.rows) / 28))));
    var c = Math.max(1, Math.min(30, Math.round(threshold)));
    cvRef.adaptiveThreshold(gray, bw, 255, cvRef.ADAPTIVE_THRESH_GAUSSIAN_C, cvRef.THRESH_BINARY, block, c);
    cvRef.cvtColor(bw, rgba, cvRef.COLOR_GRAY2RGBA);
    return rgba;
  } finally {
    drop([gray, bw]);
  }
}

function processFrame(message) {
  var options = message.options || {};
  var src = matFromRgba(message.width, message.height, message.buffer);
  var current = src;
  var corners = imageCorners(src);
  var foundQuad = false;
  var angle = 0;
  try {
    if (options.perspective) {
      if (options.corners && options.corners.length === 4) {
        corners = options.corners.map(function (point) {
          return {
            x: Math.max(0, Math.min(src.cols - 1, point.x)),
            y: Math.max(0, Math.min(src.rows - 1, point.y)),
          };
        });
        foundQuad = true;
      } else {
        var detected = findQuad(current);
        corners = detected.corners;
        foundQuad = detected.found;
      }
      var warped = warpQuad(current, corners);
      if (current !== src) current.delete();
      current = warped;
    }
    if (options.deskew) {
      angle = deskewAngle(current);
      if (angle !== 0) {
        var turned = rotateRgba(current, angle);
        if (current !== src) current.delete();
        current = turned;
      }
    }
    if (options.whiten) {
      var white = whiten(current, options.strength || "medium");
      if (current !== src) current.delete();
      current = white;
    }
    if (options.binary) {
      var bw = binarize(current, options.threshold == null ? 8 : options.threshold);
      if (current !== src) current.delete();
      current = bw;
    }
    return {
      width: current.cols,
      height: current.rows,
      buffer: cloneToBuffer(current),
      corners: corners,
      foundQuad: foundQuad,
      angle: angle,
    };
  } finally {
    if (current !== src) current.delete();
    src.delete();
  }
}
