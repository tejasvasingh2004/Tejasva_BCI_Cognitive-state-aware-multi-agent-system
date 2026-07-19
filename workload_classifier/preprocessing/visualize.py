# visualize.py
"""Visualisation utilities for comparing raw and preprocessed EEG signals.

Generates before-and-after plots for:
1. Time-series comparison (drift and high-frequency noise removal).
2. Power Spectral Density (PSD) comparison (visualizing filter cuts and notch effects).

All plots are designed with professional aesthetics and saved to the plots directory.
"""

import os
import matplotlib.pyplot as plt
import numpy as np
import seaborn as sns
from scipy.signal import welch

# Set modern plotting theme
sns.set_theme(style="whitegrid", context="talk", palette="muted")
plt.rcParams.update({
    "font.family": "sans-serif",
    "font.sans-serif": ["Inter", "Roboto", "Helvetica", "Arial"],
    "figure.titlesize": 18,
    "axes.titlesize": 16,
    "axes.labelsize": 14,
    "xtick.labelsize": 12,
    "ytick.labelsize": 12,
})


def plot_timeseries_comparison(
    raw_data: np.ndarray,
    clean_data: np.ndarray,
    fs: int = 128,
    epoch_idx: int = 0,
    channel_idx: int = 0,
    channel_name: str = "AF3",
    save_path: str = None
):
    """Plot before-and-after time-series comparison for a single channel.

    Parameters
    ----------
    raw_data : np.ndarray, shape (n_epochs, n_channels, n_times)
        Raw EEG data.
    clean_data : np.ndarray, shape (n_epochs, n_channels, n_times)
        Preprocessed EEG data.
    fs : int, default=128
        Sampling frequency in Hz.
    epoch_idx : int, default=0
        Index of the epoch to plot.
    channel_idx : int, default=0
        Index of the channel to plot.
    channel_name : str, default='AF3'
        Label/name of the channel.
    save_path : str, optional
        File path to save the generated plot.
    """
    raw_signal = raw_data[epoch_idx, channel_idx]
    clean_signal = clean_data[epoch_idx, channel_idx]
    n_times = len(raw_signal)
    time = np.arange(n_times) / fs

    fig, axes = plt.subplots(2, 1, figsize=(14, 8), sharex=True)
    
    # 1. Plot Raw Signal (containing drift and noise)
    axes[0].plot(time, raw_signal, color="#d95f02", alpha=0.85, linewidth=1.2)
    axes[0].set_title(f"Raw EEG Signal – Epoch {epoch_idx + 1}, Channel {channel_name}", weight="bold")
    axes[0].set_ylabel("Amplitude (μV)")
    axes[0].grid(True, linestyle="--", alpha=0.5)

    # 2. Plot Preprocessed Signal (clean, band-limited, standardized)
    axes[1].plot(time, clean_signal, color="#1b9e77", alpha=0.9, linewidth=1.2)
    axes[1].set_title(f"Preprocessed EEG Signal (1-40 Hz Band-pass, 50 Hz Notch, CAR, Standardized)", weight="bold")
    axes[1].set_ylabel("Amplitude (Z-score)")
    axes[1].set_xlabel("Time (seconds)")
    axes[1].grid(True, linestyle="--", alpha=0.5)

    plt.tight_layout()

    if save_path:
        os.makedirs(os.path.dirname(save_path), exist_ok=True)
        plt.savefig(save_path, dpi=300, bbox_inches="tight")
        print(f"Saved time-series comparison plot to: {save_path}")
    plt.close()


def plot_psd_comparison(
    raw_data: np.ndarray,
    clean_data: np.ndarray,
    fs: int = 128,
    save_path: str = None
):
    """Plot before-and-after Power Spectral Density (PSD) averaged over all channels and epochs.

    Parameters
    ----------
    raw_data : np.ndarray, shape (n_epochs, n_channels, n_times)
        Raw EEG data.
    clean_data : np.ndarray, shape (n_epochs, n_channels, n_times)
        Preprocessed EEG data.
    fs : int, default=128
        Sampling frequency.
    save_path : str, optional
        File path to save the plot.
    """
    # Calculate PSD using Welch method
    # Shape of PSD will be (n_epochs, n_channels, n_freqs)
    # Average across epochs and channels to get mean PSD spectrum
    
    n_fft = min(512, raw_data.shape[-1])
    
    freqs, raw_psd = welch(raw_data, fs=fs, nperseg=n_fft, axis=-1)
    _, clean_psd = welch(clean_data, fs=fs, nperseg=n_fft, axis=-1)

    mean_raw_psd = np.mean(raw_psd, axis=(0, 1))
    mean_clean_psd = np.mean(clean_psd, axis=(0, 1))

    # Convert PSD to decibels for log scaling: 10 * log10(power)
    # Add a small epsilon to avoid log(0)
    eps = 1e-15
    raw_psd_db = 10 * np.log10(mean_raw_psd + eps)
    clean_psd_db = 10 * np.log10(mean_clean_psd + eps)

    plt.figure(figsize=(12, 6.5))
    
    plt.plot(freqs, raw_psd_db, label="Raw Signals", color="#d95f02", linewidth=2, alpha=0.7)
    plt.plot(freqs, clean_psd_db, label="Preprocessed (1-40 Hz Band-pass + 50 Hz Notch)", color="#1b9e77", linewidth=2.5, alpha=0.9)
    
    plt.axvspan(1.0, 40.0, color="#1b9e77", alpha=0.08, label="Passband (1-40 Hz)")
    plt.axvline(50.0, color="#7570b3", linestyle="--", linewidth=1.5, alpha=0.7, label="Notch (50 Hz)")

    plt.title("Averaged EEG Power Spectral Density (PSD) Comparison", weight="bold", pad=15)
    plt.xlabel("Frequency (Hz)")
    plt.ylabel("Power Spectral Density (dB/Hz)")
    plt.xlim(0, 64)  # Nyquist is 64 Hz (128 Hz sampling rate)
    plt.legend(loc="upper right", frameon=True, facecolor="white", edgecolor="none")
    plt.grid(True, linestyle="--", alpha=0.5)

    plt.tight_layout()

    if save_path:
        os.makedirs(os.path.dirname(save_path), exist_ok=True)
        plt.savefig(save_path, dpi=300, bbox_inches="tight")
        print(f"Saved PSD comparison plot to: {save_path}")
    plt.close()
