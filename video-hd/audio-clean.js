/* Nouf Vidéo HD : nettoyage du son
 * 1. Vent : filtre passe-haut (4e ordre) + atténuation des rafales graves détectées image par image.
 * 2. Bruit de fond : réduction spectrale (profil de bruit mesuré dans les silences, gains lissés).
 * 3. Volume : mise à niveau douce (crête à -1 dB, gain max ×4).
 * Entrée / sortie : tableaux Float32Array par canal (planaires). */

const makeFFT = (n) => {
	const lev = Math.log2(n);
	const rev = new Uint32Array(n);
	for (let i = 0; i < n; i++) {
		let r = 0;
		for (let b = 0; b < lev; b++) { r = (r << 1) | ((i >> b) & 1); }
		rev[i] = r;
	}
	const cos = new Float32Array(n / 2), sin = new Float32Array(n / 2);
	for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / n); sin[i] = Math.sin(2 * Math.PI * i / n); }
	return (re, im, inv) => {
		for (let i = 0; i < n; i++) {
			const j = rev[i];
			if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
		}
		const s = inv ? 1 : -1;
		for (let size = 2; size <= n; size <<= 1) {
			const half = size >> 1, step = n / size;
			for (let i = 0; i < n; i += size) {
				for (let j = 0, k = 0; j < half; j++, k += step) {
					const a = i + j, b = a + half;
					const wr = cos[k], wi = s * sin[k];
					const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
					re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
				}
			}
		}
	};
};

const highPass = (x, sr, fc) => {
	// Butterworth 4e ordre = deux biquads (Q 0.5412 et 1.3066)
	for (const Q of [0.5412, 1.3066]) {
		const w = 2 * Math.PI * fc / sr, c = Math.cos(w), al = Math.sin(w) / (2 * Q);
		const a0 = 1 + al;
		const b0 = (1 + c) / 2 / a0, b1 = -(1 + c) / a0, b2 = b0, a1 = -2 * c / a0, a2 = (1 - al) / a0;
		let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
		for (let i = 0; i < x.length; i++) {
			const xi = x[i];
			const y = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
			x2 = x1; x1 = xi; y2 = y1; y1 = y;
			x[i] = y;
		}
	}
};

const tick = () => new Promise(r => setTimeout(r, 0));

/**
 * @param {Float32Array[]} chans  canaux (modifiés / remplacés)
 * @param {number} sr  fréquence d'échantillonnage
 * @param {{wind:boolean, noise:0|1|2|3, level:boolean}} opt
 * @param {(p:number)=>void} [onProgress]
 * @returns {Promise<Float32Array[]>}
 */
export const cleanAudio = async (chans, sr, opt, onProgress = () => {}) => {
	const C = chans.length, L = chans[0].length;
	if (!L) { return chans; }

	if (opt.wind) {
		for (const x of chans) { highPass(x, sr, 110); }
	}

	const spectral = opt.wind || opt.noise > 0;
	let out = chans;
	if (spectral) {
		const N = sr > 32000 ? 1024 : 512, H = N / 4, B = N / 2 + 1;
		const fft = makeFFT(N);
		const win = new Float32Array(N);
		for (let i = 0; i < N; i++) { win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N); }
		const frames = Math.ceil((L + N) / H) + 1;
		const pos = f => f * H - N; // début de la trame (avec marge)
		const re = new Float32Array(N), im = new Float32Array(N);
		const binHz = sr / N;

		// --- Profil du bruit : minimum de chaque bande sur des blocs de ~0,8 s, puis médiane des minima
		let noise = null;
		if (opt.noise > 0) {
			const blk = Math.max(8, Math.round(0.8 * sr / H));
			const mins = [];
			let cur = new Float32Array(B).fill(Infinity), cnt = 0;
			const sm = new Float32Array(B); let started = false;
			for (let f = 0; f < frames; f++) {
				const p0 = pos(f);
				if ((p0 < 0 || p0 + N > L) && L > 4 * N) { continue; } // trames incomplètes : faussent le profil
				for (let i = 0; i < N; i++) {
					const k = p0 + i;
					let v = 0;
					if (k >= 0 && k < L) { for (let c = 0; c < C; c++) { v += chans[c][k]; } v /= C; }
					re[i] = v * win[i]; im[i] = 0;
				}
				fft(re, im, false);
				for (let b = 0; b < B; b++) { const pw = re[b] * re[b] + im[b] * im[b]; sm[b] = started ? sm[b] * 0.85 + pw * 0.15 : pw; if (sm[b] < cur[b]) { cur[b] = sm[b]; } }
				started = true;
				if (++cnt === blk) { mins.push(cur); cur = new Float32Array(B).fill(Infinity); cnt = 0; }
				if ((f & 511) === 0) { onProgress(0.3 * f / frames); await tick(); }
			}
			if (cnt > blk / 2 || !mins.length) { mins.push(cur); }
			noise = new Float32Array(B);
			const col = new Float32Array(mins.length);
			for (let b = 0; b < B; b++) {
				for (let m = 0; m < mins.length; m++) { col[m] = Number.isFinite(mins[m][b]) ? mins[m][b] : 0; }
				const sorted = Array.from(col).sort((a, z) => a - z);
				noise[b] = sorted[Math.floor(sorted.length * 0.4)] * 1.8; // minima lissés → niveau moyen du bruit
			}
		}

		const alpha = [0, 1.2, 1.8, 2.6][opt.noise] || 0;
		const floor = [1, 0.32, 0.2, 0.12][opt.noise] || 1;
		out = chans.map(() => new Float32Array(L));
		const res = Array.from({ length: C }, () => [new Float32Array(N), new Float32Array(N)]);
		const G = new Float32Array(B), Gp = new Float32Array(B).fill(1), Gs = new Float32Array(B), P = new Float32Array(B);
		let gWindPrev = 1;
		const lowEnd = Math.round(250 / binHz), midEnd = Math.round(4000 / binHz), windTop = Math.round(600 / binHz), windFade = Math.round(900 / binHz);
		const norm = 1 / 1.5; // somme des fenêtres de Hann² avec recouvrement de 75 %

		for (let f = 0; f < frames; f++) {
			const p0 = pos(f);
			P.fill(0);
			for (let c = 0; c < C; c++) {
				const [r, i2] = res[c], x = chans[c];
				for (let i = 0; i < N; i++) { const k = p0 + i; r[i] = (k >= 0 && k < L ? x[k] : 0) * win[i]; i2[i] = 0; }
				fft(r, i2, false);
				for (let b = 0; b < B; b++) { P[b] += (r[b] * r[b] + i2[b] * i2[b]) / C; }
			}
			// Gains anti-bruit
			for (let b = 0; b < B; b++) {
				let g = 1;
				if (noise) { g = 1 - alpha * noise[b] / (P[b] + 1e-12); if (g < floor) { g = floor; } }
				G[b] = g;
			}
			// Lissage en fréquence puis en temps (attaque rapide, relâchement lent)
			for (let b = 0; b < B; b++) { Gs[b] = (G[Math.max(0, b - 1)] + 2 * G[b] + G[Math.min(B - 1, b + 1)]) / 4; }
			for (let b = 0; b < B; b++) { const g = Gs[b] > Gp[b] ? Gs[b] : Gp[b] * 0.65 + Gs[b] * 0.35; Gp[b] = g; G[b] = g; }
			// Rafales de vent : énergie grave très supérieure aux médiums
			if (opt.wind) {
				let lo = 0, mid = 0;
				for (let b = 1; b < lowEnd; b++) { lo += P[b]; }
				for (let b = lowEnd; b < midEnd; b++) { mid += P[b]; }
				const ratio = lo / (mid + 1e-12);
				let gw = ratio > 1.5 ? Math.max(0.12, Math.sqrt(1.5 / ratio)) : 1;
				gw = gw < gWindPrev ? gw : gWindPrev * 0.8 + gw * 0.2;
				gWindPrev = gw;
				if (gw < 1) {
					for (let b = 0; b < windFade; b++) {
						const t = b <= windTop ? 0 : (b - windTop) / (windFade - windTop);
						G[b] *= gw + (1 - gw) * t;
					}
				}
			}
			// Application + reconstruction
			for (let c = 0; c < C; c++) {
				const [r, i2] = res[c], y = out[c];
				for (let b = 0; b < B; b++) { r[b] *= G[b]; i2[b] *= G[b]; }
				for (let b = 1; b < N / 2; b++) { r[N - b] = r[b]; i2[N - b] = -i2[b]; }
				fft(r, i2, true);
				for (let i = 0; i < N; i++) {
					const k = p0 + i;
					if (k >= 0 && k < L) { y[k] += r[i] / N * win[i] * norm; }
				}
			}
			if ((f & 511) === 0) { onProgress(0.3 + 0.65 * f / frames); await tick(); }
		}
	}

	if (opt.level) {
		let peak = 0;
		for (const y of out) { for (let i = 0; i < y.length; i++) { const a = Math.abs(y[i]); if (a > peak) { peak = a; } } }
		if (peak > 1e-4) {
			const g = Math.min(4, 0.89 / peak);
			for (const y of out) { for (let i = 0; i < y.length; i++) { y[i] *= g; } }
		}
	}
	onProgress(1);
	return out;
};
