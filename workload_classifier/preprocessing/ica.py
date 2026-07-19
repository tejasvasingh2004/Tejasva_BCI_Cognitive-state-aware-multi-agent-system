# ica.py
"""Experimental Independent Component Analysis (ICA) for artifact removal.

Provides a scikit-learn-based FastICA implementation to decompose 14-channel
EEG signals into spatial source components, automatically detect ocular/blink
artifacts, and reconstruct the cleaned EEG signals.
"""

import numpy as np
from sklearn.decomposition import FastICA


def run_experimental_ica(
    data: np.ndarray,
    n_components: int = 12,
    kurtosis_threshold: float = 3.0,
    correlation_threshold: float = 0.5
) -> np.ndarray:
    """Decompose and reconstruct the EEG signals using FastICA to remove ocular/muscle artifacts.

    Scientific Justification:
    - Independent Component Analysis (ICA) assumes that the recorded multi-channel
      EEG is a linear mixture of independent source components (e.g. brain activity,
      blinks, muscle tension).
    - By finding the unmixing matrix, we can isolate ocular artifacts (which are
      characterized by high amplitude spikes on frontal channels and high statistical
      kurtosis) and zero them out before reconstructing the signal.
    - Since Emotiv EPOC has only 14 channels, running ICA is highly constrained. We
      treat this as an experimental module to evaluate if removing components
      improves classification without distorting relevant EEG signals.

    Parameters
    ----------
    data : np.ndarray, shape (n_epochs, n_channels, n_times)
        Preprocessed EEG signals.
    n_components : int, default=12
        Number of components for FastICA. Must be <= n_channels (14).
    kurtosis_threshold : float, default=3.0
        Z-score kurtosis threshold to identify spiky ocular artifacts.
    correlation_threshold : float, default=0.5
        Pearson correlation threshold with frontal channels (AF3, AF4) to identify ocular artifacts.

    Returns
    -------
    np.ndarray
        Cleaned EEG signals with shape (n_epochs, n_channels, n_times).
    """
    n_epochs, n_channels, n_times = data.shape
    
    # 1. Flatten the epochs into a continuous channel-time matrix
    # Shape: (n_channels, n_epochs * n_times)
    flat_data = data.transpose(1, 0, 2).reshape(n_channels, -1)
    
    # FastICA expects shape (n_samples, n_features), which translates to
    # (time_points, channels) in EEG processing.
    X_ica = flat_data.T  # Shape: (n_epochs * n_times, n_channels)
    
    # 2. Fit FastICA
    ica = FastICA(n_components=n_components, random_state=42, max_iter=500)
    sources = ica.fit_transform(X_ica)  # Shape: (n_epochs * n_times, n_components)
    
    # 3. Identify artifact components
    # Frontal channels in Emotiv EPOC 14-channel layout:
    # Indices: AF3 = 0, AF4 = 13 (channels: AF3, F7, F3, FC5, T7, P7, O1, O2, P8, T8, FC6, F4, F8, AF4)
    frontal_indices = [0, 13]
    frontal_signals = X_ica[:, frontal_indices]
    
    rejected_components = []
    
    # Calculate kurtosis and correlations for each component source
    for c in range(n_components):
        source_comp = sources[:, c]
        
        # Kurtosis: high values (>3.0 above Gaussian) suggest spiky blink artifacts
        mean_s = np.mean(source_comp)
        std_s = np.std(source_comp)
        if std_s == 0:
            continue
        kurt = np.mean(((source_comp - mean_s) / std_s) ** 4) - 3.0
        
        # Correlation with frontal channels (typical of eye blinks)
        corrs = [np.corrcoef(source_comp, frontal_signals[:, idx])[0, 1] for idx in range(len(frontal_indices))]
        max_corr = np.max(np.abs(corrs))
        
        # Mark as artifact if kurtosis is extremely high or frontal correlation exceeds threshold
        if kurt > kurtosis_threshold or max_corr > correlation_threshold:
            rejected_components.append(c)
            
    # 4. Zero-out the rejected artifact components
    cleaned_sources = sources.copy()
    if rejected_components:
        cleaned_sources[:, rejected_components] = 0.0
        
    # 5. Reconstruct the signal: Sources * Mixing_matrix.T + Mean
    # Note: FastICA reconstructs via inverse_transform or mixing matrix multiplication
    reconstructed_flat = ica.inverse_transform(cleaned_sources)  # Shape: (n_epochs * n_times, n_channels)
    
    # 6. Reshape back to (n_epochs, n_channels, n_times)
    cleaned_data = reconstructed_flat.T.reshape(n_channels, n_epochs, n_times).transpose(1, 0, 2)
    
    # Baseline correct again after reconstruction to remove any offsets introduced by ICA
    mean_offset = np.mean(cleaned_data, axis=-1, keepdims=True)
    cleaned_data = cleaned_data - mean_offset
    
    return cleaned_data
