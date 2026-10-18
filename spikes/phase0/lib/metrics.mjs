// Frame-level comparisons of probability traces against labels.

// Area under the ROC curve: the chance that a random speech frame scores
// higher than a random non-speech frame.
export function auc(scores, labels) {
  const idx = scores.map((s, i) => i).sort((a, b) => scores[a] - scores[b]);
  let rankSum = 0;
  let pos = 0;
  for (let r = 0; r < idx.length;) {
    let e = r;
    while (e + 1 < idx.length && scores[idx[e + 1]] === scores[idx[r]]) e++;
    const avgRank = (r + e) / 2 + 1;
    for (let k = r; k <= e; k++) if (labels[idx[k]]) { rankSum += avgRank; pos++; }
    r = e + 1;
  }
  const neg = idx.length - pos;
  if (!pos || !neg) return NaN;
  return (rankSum - pos * (pos + 1) / 2) / (pos * neg);
}

// Fraction of the selected frames whose score is above the threshold.
export function rateAbove(scores, select, threshold) {
  let n = 0;
  let k = 0;
  for (let i = 0; i < scores.length; i++) {
    if (!select[i]) continue;
    n++;
    if (scores[i] > threshold) k++;
  }
  return n ? k / n : NaN;
}

export function median(xs) {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function inIntervals(t, intervals) {
  for (const [s, e] of intervals) if (t >= s && t < e) return true;
  return false;
}
