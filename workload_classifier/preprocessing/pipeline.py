# pipeline.py
"""Preprocessing pipeline coordinator for the STEW dataset.

Defines the configuration options and provides the main entry point to run
the full preprocessing sequence (bandpass, notch, CAR, optional ICA, baseline correction, scaling)
on raw EEG data loaded directly from .mat files.
"""

from dataclasses import dataclass
from typing import Tuple
import numpy as np

from workload_classifier.preprocessing.filter import (
    bandpass_filter,
    notch_filter,
    common_average_reference,
    baseline_correction,
    channel_scaling,
)
from workload_classifier.preprocessing.ica import run_experimental_ica


@dataclass
class PreprocessingConfig:
    """Configuration options for the preprocessing pipeline.
    
    All options are documented with scientific rationale.
    """
    # Bandpass filter settings (1.0 - 40.0 Hz)
    lowcut: float = 1.0  # High-pass cut-off frequency. Removes slow drifts.
    highcut: float = 40.0  # Low-pass cut-off frequency. Removes muscle tension and noise.
    filter_order: int = 4  # Butterworth filter order.
    
    # Notch filter settings (50 Hz power-line noise in Singapore)
    apply_notch: bool = True
    notch_freq: float = 50.0  # Frequency to reject (Hz).
    notch_q: float = 30.0  # Quality factor for narrow notch.
    
    # Re-referencing setting (CAR)
    apply_car: bool = True  # Reduces common-mode noise across wireless headset sensors.
    
    # Experimental Independent Component Analysis (ICA)
    apply_ica: bool = False  # Set to True only for experimental artifact rejection.
    ica_components: int = 12  # Number of components (<= 14 channels).
    
    # Baseline correction and standardization
    apply_baseline: bool = True  # Centers signal at zero.
    apply_scaling: bool = True  # Z-score normalization for inter-subject amplitude comparison.
    
    # Optional Sliding Window Segmentation
    segment_seconds: float = None  # If None, preserves original 150-second epochs.
    segment_overlap: float = 0.0  # Overlap fraction between consecutive windows.
    sampling_rate: int = 128  # Sampling frequency of the STEW dataset.


def preprocess_dataset(
    X_raw: np.ndarray,
    config: PreprocessingConfig = None
) -> np.ndarray:
    """Run the raw EEG signals through the preprocessing pipeline.

    Parameters
    ----------
    X_raw : np.ndarray, shape (n_epochs, n_channels, n_times)
        Raw EEG signals loaded directly from dataset.mat.
        Dimensions: (45 subjects/epochs, 14 channels, 19200 time points).
    config : PreprocessingConfig, optional
        Configuration settings for the pipeline. Defaults to standard settings.

    Returns
    -------
    np.ndarray
        Preprocessed EEG signals.
    """
    if config is None:
        config = PreprocessingConfig()

    X = X_raw.copy().astype(float)
    
    # 1. Band-pass Filter (1.0 Hz - 40.0 Hz)
    # Rationale: Removes slow trends and high-frequency EMG muscle noise.
    X = bandpass_filter(
        X,
        lowcut=config.lowcut,
        highcut=config.highcut,
        order=config.filter_order
    )
    
    # 2. Notch Filter (50.0 Hz)
    # Rationale: Specific suppression of mains power-line noise in the recording site.
    if config.apply_notch:
        X = notch_filter(X, freq=config.notch_freq, q=config.notch_q)
        
    # 3. Common Average Reference (CAR)
    # Rationale: Reduces spatial noise by referencing to the instantaneous channel average.
    if config.apply_car:
        X = common_average_reference(X)
        
    # 4. Optional Experimental ICA
    # Rationale: Experimental ocular and muscle artifact separation.
    if config.apply_ica:
        X = run_experimental_ica(X, n_components=config.ica_components)
        
    # 5. Baseline Correction
    # Rationale: Centers signals vertically around zero before scaling or feature extraction.
    if config.apply_baseline:
        X = baseline_correction(X)
        
    # 6. Channel-wise Standardization (Scaling)
    # Rationale: Equalizes amplitude variations due to contact quality and skull differences.
    if config.apply_scaling:
        X = channel_scaling(X)
        
    # 7. Optional Segmenting (Data Augmentation)
    # Checked only if segment_seconds is set. Default is None (preserve continuous recordings).
    if config.segment_seconds is not None:
        X = segment_epochs(X, config.segment_seconds, config.segment_overlap, config.sampling_rate)
        
    return X


def segment_epochs(
    data: np.ndarray,
    segment_seconds: float,
    overlap: float = 0.0,
    fs: int = 128
) -> np.ndarray:
    """Segment continuous EEG epochs into shorter sliding windows (Optional / Experimental).

    Parameters
    ----------
    data : np.ndarray, shape (n_epochs, n_channels, n_times)
        Preprocessed continuous EEG signals.
    segment_seconds : float
        Length of each window in seconds.
    overlap : float, default=0.0
        Overlap fraction between consecutive windows (0.0 to <1.0).
    fs : int, default=128
        Sampling frequency in Hz.

    Returns
    -------
    np.ndarray, shape (n_segmented_epochs, n_channels, segment_samples)
        Segmented EEG epochs.
    """
    n_epochs, n_channels, n_times = data.shape
    segment_samples = int(segment_seconds * fs)
    step_samples = int(segment_samples * (1 - overlap))
    
    if segment_samples > n_times:
        raise ValueError(
            f"Segment length ({segment_samples} samples) is larger than the "
            f"recording duration ({n_times} samples)."
        )
        
    segments = []
    
    for i in range(n_epochs):
        start = 0
        while start + segment_samples <= n_times:
            end = start + segment_samples
            segments.append(data[i, :, start:end])
            start += step_samples
            
    return np.array(segments)
