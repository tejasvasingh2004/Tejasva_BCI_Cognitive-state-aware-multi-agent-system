# filter.py
"""Preprocessing utilities for STEW EEG dataset.

Provides vectorized, high-performance implementations of the following steps:
1. Band-pass filtering (1.0 - 40.0 Hz) using a zero-phase 4th-order Butterworth filter.
2. Notch filtering (50.0 Hz) using a zero-phase IIR notch filter.
3. Common Average Referencing (CAR) across all 14 channels.
4. Baseline correction (zero-mean) per channel/epoch.
5. Amplitude standardization (z-score scaling) per channel/epoch.

All functions are optimized to use NumPy vectorization along the time axis (axis=-1)
to avoid slow Python loops. Detailed scientific justifications for each step are
provided in their respective docstrings.
"""

import numpy as np
from scipy.signal import butter, filtfilt, iirnotch

# Official sampling rate of the STEW dataset (Hz), recorded using Emotiv EPOC
FS = 128


def bandpass_filter(
    data: np.ndarray,
    lowcut: float = 1.0,
    highcut: float = 40.0,
    order: int = 4
) -> np.ndarray:
    """Apply a zero-phase Butterworth band-pass filter along the time axis.

    Scientific Justification:
    - High-pass cut-off at 1.0 Hz removes very slow drifts, sweat artifacts,
      and DC offset without removing important neural activity.
    - Low-pass cut-off at 40.0 Hz eliminates high-frequency muscle tension
      (EMG) artifacts and sensor noise, which are highly prevalent in wireless
      headsets like the Emotiv EPOC.
    - This passband fully preserves the primary EEG bands relevant to mental
      workload classification: Theta (4-8 Hz), Alpha (8-12 Hz), and Beta (12-30 Hz).
    - Zero-phase filtering via `filtfilt` prevents phase distortion, keeping the
      temporal alignment of the EEG signals exact.

    Parameters
    ----------
    data : np.ndarray, shape (..., n_times)
        Raw EEG signals. The last axis must be the time dimension.
    lowcut : float, default=1.0
        Lower cut-off frequency in Hz.
    highcut : float, default=40.0
        Upper cut-off frequency in Hz.
    order : int, default=4
        Butterworth filter order (effective order is doubled due to zero-phase filtfilt).

    Returns
    -------
    np.ndarray
        Filtered EEG signals of the same shape as input.
    """
    nyq = 0.5 * FS
    low = lowcut / nyq
    high = highcut / nyq
    
    # 4th-order bandpass butterworth filter coefficient generation
    b, a = butter(order, [low, high], btype="band")
    
    # Vectorized zero-phase filtering along the last (time) axis
    return filtfilt(b, a, data, axis=-1)


def notch_filter(data: np.ndarray, freq: float = 50.0, q: float = 30.0) -> np.ndarray:
    """Apply a zero-phase IIR notch (band-stop) filter to remove power-line noise.

    Scientific Justification:
    - The STEW dataset was recorded in Singapore, which uses a 50 Hz power grid.
    - Ambient electrical signals (power-line noise) heavily contaminate raw EEG
      measurements. A notch filter centered at 50 Hz with a high Quality factor (Q=30)
      completely suppresses this frequency while leaving adjacent neural bands untouched.

    Parameters
    ----------
    data : np.ndarray, shape (..., n_times)
        EEG signals. The last axis must be the time dimension.
    freq : float, default=50.0
        The frequency to reject (Hz).
    q : float, default=30.0
        Quality factor. A higher Q factor results in a narrower notch bandwidth.

    Returns
    -------
    np.ndarray
        Filtered EEG signals.
    """
    nyq = 0.5 * FS
    w0 = freq / nyq
    b, a = iirnotch(w0, q)
    return filtfilt(b, a, data, axis=-1)


def common_average_reference(data: np.ndarray) -> np.ndarray:
    """Re-reference the EEG signal to the average of all channels.

    Scientific Justification:
    - The Emotiv EPOC uses CMS/DRL reference sensors on the mastoids, which can
      introduce common-mode noise across all electrodes if the subject moves.
    - Subtracting the instantaneous average of all channels (CAR) cancels out
      widespread common-mode noise and references the recordings to a neutral
      average baseline, enhancing local, focal neural signals.

    Parameters
    ----------
    data : np.ndarray, shape (n_epochs, n_channels, n_times)
        EEG signals.

    Returns
    -------
    np.ndarray
        CAR re-referenced EEG signals.
    """
    # Average across the channel axis (axis=1) and subtract from data
    channel_avg = np.mean(data, axis=1, keepdims=True)
    return data - channel_avg


def baseline_correction(data: np.ndarray) -> np.ndarray:
    """Subtract the mean of each epoch per channel.

    Scientific Justification:
    - Subtracting the average signal level (DC offset) of each individual epoch
      ensures the signal is centered at zero.
    - This eliminates vertical offsets that can bias subsequent operations,
      such as Fourier Transforms for Power Spectral Density (PSD) calculation.

    Parameters
    ----------
    data : np.ndarray, shape (..., n_times)
        EEG signals.

    Returns
    -------
    np.ndarray
        Baseline-corrected EEG signals.
    """
    # Subtract mean along the time axis (axis=-1)
    mean = np.mean(data, axis=-1, keepdims=True)
    return data - mean


def channel_scaling(data: np.ndarray) -> np.ndarray:
    """Standardize the EEG signal amplitude per channel per epoch (Z-score).

    Scientific Justification:
    - Skull thickness, hair density, skin impedance, and contact quality
      cause large amplitude variations across channels and subjects.
    - Z-score normalization (dividing by the channel standard deviation) makes the
      signal amplitudes comparable, ensuring that features reflect relative brain
      activity changes rather than physical differences in electrode contact.

    Parameters
    ----------
    data : np.ndarray, shape (..., n_times)
        EEG signals.

    Returns
    -------
    np.ndarray
        Standardized EEG signals.
    """
    mean = np.mean(data, axis=-1, keepdims=True)
    std = np.std(data, axis=-1, keepdims=True)
    
    # Protect against division by zero for any flat channels
    std = np.where(std == 0.0, 1.0, std)
    
    return (data - mean) / std
