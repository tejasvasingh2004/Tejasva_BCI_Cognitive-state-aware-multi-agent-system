# extractor.py
"""Feature extraction module for STEW EEG workload dataset.

Segments preprocessed continuous EEG signals and extracts time-domain and
frequency-domain features (Absolute/Relative Band Power, Differential Entropy,
Spectral Entropy, and Hjorth Parameters) with high mathematical rigor.
"""

import sys
import pathlib
import numpy as np
from scipy.signal import welch
from typing import Tuple, Dict

# Ensure parent directory is in sys.path for local module imports
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from workload_classifier.utils.data_loader import FS, N_CHANNELS

# Cognitive workload-relevant EEG frequency bands.
# Delta (<4 Hz) is excluded to avoid eye-movement artifacts.
# Gamma (>30 Hz) is excluded to avoid muscle tension/EMG contamination.
BANDS = {
    "theta": (4.0, 8.0),   # Associated with memory load, encoding, and mental effort
    "alpha": (8.0, 12.0),  # Associated with cortical idling; power decreases during active tasks
    "beta": (12.0, 30.0)   # Associated with active cognitive processing and alertness
}


def segment_data(
    X: np.ndarray,
    y_bin: np.ndarray,
    y_thr: np.ndarray,
    subject_ids: np.ndarray,
    window_len_sec: float = 10.0,
    step_len_sec: float = 5.0
) -> Tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Segment continuous EEG recordings into overlapping windows.

    Scientific Justification:
    - Estimating mental workload over long, continuous recordings can obscure
      short-term cognitive fluctuations. Segmenting the data into sliding windows
      allows the model to capture stationary local features.
    - 10-second windows at 128 Hz provide 1280 samples, which is statistically
      sufficient for stable power spectral density (PSD) estimation, while a 5-second
      step size provides substantial data augmentation (1305 epochs total) without
      overly redundant overlaps.

    Parameters
    ----------
    X : np.ndarray, shape (n_epochs, n_channels, n_times)
        Preprocessed EEG recordings.
    y_bin : np.ndarray, shape (n_epochs,)
        Binary labels.
    y_thr : np.ndarray, shape (n_epochs,)
        Three-class labels.
    subject_ids : np.ndarray, shape (n_epochs,)
        Subject IDs.
    window_len_sec : float, default=10.0
        Length of each window in seconds.
    step_len_sec : float, default=5.0
        Shift between consecutive windows in seconds.

    Returns
    -------
    X_wins : np.ndarray, shape (n_windows, n_channels, window_samples)
        Segmented EEG windows.
    y_bin_wins : np.ndarray, shape (n_windows,)
        Binary labels mapped to each window.
    y_thr_wins : np.ndarray, shape (n_windows,)
        Three-class labels mapped to each window.
    subj_wins : np.ndarray, shape (n_windows,)
        Subject IDs mapped to each window.
    """
    window_samples = int(window_len_sec * FS)
    step_samples = int(step_len_sec * FS)
    n_epochs, n_channels, n_times = X.shape

    X_wins_list = []
    y_bin_wins_list = []
    y_thr_wins_list = []
    subj_wins_list = []

    for idx in range(n_epochs):
        subj = subject_ids[idx]
        yb = y_bin[idx]
        yt = y_thr[idx]
        signal = X[idx]  # Shape: (14, 19200)

        # Slide window across the time axis
        start = 0
        while start + window_samples <= n_times:
            win = signal[:, start : start + window_samples]
            X_wins_list.append(win)
            y_bin_wins_list.append(yb)
            y_thr_wins_list.append(yt)
            subj_wins_list.append(subj)
            start += step_samples

    return (
        np.array(X_wins_list),
        np.array(y_bin_wins_list),
        np.array(y_thr_wins_list),
        np.array(subj_wins_list)
    )


def hjorth_parameters(signal: np.ndarray) -> Tuple[float, float, float]:
    """Calculate Hjorth parameters (Activity, Mobility, Complexity) for a 1D signal.

    Mathematical Intuition:
    - Activity: Represents the total power (variance) of the EEG signal.
      $$\text{Activity} = \sigma_x^2 = \text{Var}(x)$$
    - Mobility: Represents the mean frequency of the signal. It is defined as the
      square root of the variance of the first derivative divided by the variance of the signal.
      $$\text{Mobility} = \sqrt{\frac{\text{Var}(x')}{\text{Var}(x)}}$$
    - Complexity: Represents the frequency bandwidth (deviation from a pure sine wave).
      $$\text{Complexity} = \frac{\text{Mobility}(x')}{\text{Mobility}(x)}$$
    """
    diff1 = np.diff(signal)
    diff2 = np.diff(diff1)

    var0 = np.var(signal)
    var1 = np.var(diff1)
    var2 = np.var(diff2)

    # Activity: signal power
    activity = var0

    # Mobility: mean frequency
    mobility = np.sqrt(var1 / var0) if var0 > 0 else 0.0

    # Complexity: bandwidth change
    mobility_diff = np.sqrt(var2 / var1) if var1 > 0 else 0.0
    complexity = mobility_diff / mobility if mobility > 0 else 0.0

    return activity, mobility, complexity


def spectral_entropy(pxx: np.ndarray) -> float:
    """Calculate normalized spectral entropy given the PSD values.

    Mathematical Intuition:
    - Spectral Entropy measures the complexity or flatness of the power spectrum.
      The PSD is treated as a probability distribution $p(f) = P(f) / \sum P(f)$.
      The entropy is computed as:
      $$H_{\text{spec}} = -\sum p(f) \log_2 p(f)$$
      It is normalized by dividing by $\log_2(N)$ where $N$ is the number of frequency bins.
    - A flatter, noisier spectrum (high workload, desynchronized Alpha) results in a
      higher entropy (closer to 1.0), whereas a peaky spectrum (resting state, dominant
      Alpha) results in lower entropy.
    """
    psd_sum = np.sum(pxx)
    if psd_sum == 0:
        return 0.0
    prob = pxx / psd_sum
    prob = prob[prob > 0]  # Avoid log2(0)
    
    n_bins = len(pxx)
    if n_bins <= 1:
        return 0.0
        
    h_spec = -np.sum(prob * np.log2(prob))
    return h_spec / np.log2(n_bins)  # Normalized to [0, 1]


def differential_entropy(band_power: float) -> float:
    """Calculate Differential Entropy (DE) for a given band power.

    Mathematical Intuition:
    - Differential Entropy measures the complexity of a continuous random variable.
      Assuming that bandpass-filtered EEG signal follows a Gaussian distribution
      $X \sim \mathcal{N}(0, \sigma^2)$, the DE is calculated as:
      $$h(X) = \frac{1}{2} \ln(2 \pi e \sigma^2)$$
      Since the variance $\sigma^2$ is equivalent to the band power (Parseval's theorem),
      we compute DE directly as:
      $$DE = \frac{1}{2} \ln(2 \pi e \cdot \text{band\_power})$$
    - DE compresses amplitude differences logarithmically, mimicking biological
      sensory perception (Weber-Fechner Law) and reducing high inter-subject variability.
    """
    eps = 1e-10  # Protection against log(0)
    return 0.5 * np.log(2 * np.pi * np.e * (band_power + eps))


def extract_features_from_window(win: np.ndarray) -> np.ndarray:
    """Extract features from a single EEG window.

    Shape of win: (n_channels, window_samples)
    Returns: 1D array of features.
    """
    n_ch, n_samples = win.shape
    feats = []

    for ch in range(n_ch):
        ch_sig = win[ch]

        # 1. Compute PSD using Welch method
        # For 10-second windows (1280 samples), nperseg=256 gives a frequency
        # resolution of 0.5 Hz, suitable for capturing Theta, Alpha, and Beta.
        f, pxx = welch(ch_sig, fs=FS, nperseg=256)
        
        # Absolute band powers
        df = f[1] - f[0]
        abs_powers = []
        for band_name, (low, high) in BANDS.items():
            idx_band = np.where((f >= low) & (f <= high))[0]
            if len(idx_band) == 0:
                band_power = 0.0
            else:
                band_power = np.sum(pxx[idx_band]) * df
            abs_powers.append(band_power)

        # Sum of absolute powers in Theta, Alpha, Beta (used for normalization)
        sum_power = np.sum(abs_powers)
        if sum_power == 0:
            sum_power = 1.0

        # Relative Band Powers (RBP)
        rel_powers = [p / sum_power for p in abs_powers]

        # Differential Entropy (DE) for each band
        de_features = [differential_entropy(p) for p in abs_powers]

        # Extend absolute powers (3), relative powers (3), differential entropy (3)
        feats.extend(abs_powers)
        feats.extend(rel_powers)
        feats.extend(de_features)

        # 2. Hjorth Parameters (Activity, Mobility, Complexity)
        activity, mobility, complexity = hjorth_parameters(ch_sig)
        feats.extend([activity, mobility, complexity])

        # 3. Spectral Entropy
        se = spectral_entropy(pxx)
        feats.append(se)

    return np.array(feats)


def extract_all_features(X_wins: np.ndarray) -> np.ndarray:
    """Extract features from all segmented EEG windows.

    X_wins shape: (n_windows, n_channels, window_samples)
    Returns: (n_windows, n_features)
    """
    n_wins = X_wins.shape[0]
    sample_feat = extract_features_from_window(X_wins[0])
    n_feats = len(sample_feat)
    
    X_feats = np.empty((n_wins, n_feats), dtype=float)
    for idx in range(n_wins):
        X_feats[idx] = extract_features_from_window(X_wins[idx])
        if (idx + 1) % 500 == 0 or idx == n_wins - 1:
            print(f"  Extracted features for {idx + 1}/{n_wins} windows...")
            
    return X_feats


def load_features(force_recompute: bool = False) -> Tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Load preprocessed clean dataset, extract, and cache features.

    Returns
    -------
    X_feats : np.ndarray, shape (n_windows, n_features)
        Extracted features.
    y_bin_wins : np.ndarray, shape (n_windows,)
        Binary labels.
    y_thr_wins : np.ndarray, shape (n_windows,)
        Three-class labels.
    subj_wins : np.ndarray, shape (n_windows,)
        Subject IDs.
    """
    from workload_classifier.utils.data_loader import CACHE_DIR
    
    x_path = CACHE_DIR / "X_feats.npy"
    y_bin_path = CACHE_DIR / "y_bin_feats.npy"
    y_thr_path = CACHE_DIR / "y_thr_feats.npy"
    subj_path = CACHE_DIR / "subj_feats.npy"

    if (not force_recompute and x_path.is_file() and y_bin_path.is_file() 
            and y_thr_path.is_file() and subj_path.is_file()):
        print("Loading cached features from disk...")
        return (
            np.load(str(x_path)),
            np.load(str(y_bin_path)),
            np.load(str(y_thr_path)),
            np.load(str(subj_path))
        )

    print("Cached features not found or recompute forced. Running extraction pipeline...")
    from workload_classifier.utils.data_loader import load_data

    # Load raw labels and subject mappings
    _, y_bin, y_thr, subjs = load_data()
    
    # Load the verified clean dataset tensor
    clean_data_path = CACHE_DIR / "clean_dataset.npy"
    if not clean_data_path.is_file():
        raise FileNotFoundError(
            f"Preprocessed dataset not found at {clean_data_path}. "
            "Please run workload_classifier/analysis/run_preprocessing.py first."
        )
    X_clean = np.load(str(clean_data_path))
    print(f"Loaded preprocessed clean dataset of shape {X_clean.shape}")
    
    print("Segmenting preprocessed continuous signals into sliding windows...")
    X_wins, y_bin_wins, y_thr_wins, subj_wins = segment_data(X_clean, y_bin, y_thr, subjs)
    print(f"Segmented into {X_wins.shape[0]} windows of shape {X_wins.shape[1:]}")
    
    print("Extracting time-frequency features from all windows...")
    X_feats = extract_all_features(X_wins)
    
    print("Saving extracted features to cache...")
    np.save(str(x_path), X_feats)
    np.save(str(y_bin_path), y_bin_wins)
    np.save(str(y_thr_path), y_thr_wins)
    np.save(str(subj_path), subj_wins)
    print("Features saved successfully!")
    
    return X_feats, y_bin_wins, y_thr_wins, subj_wins


if __name__ == "__main__":
    X_f, y_b, y_t, s = load_features(force_recompute=True)
    print(f"Feature matrix successfully loaded/extracted. Shape: {X_f.shape}")
