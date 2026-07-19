# verify_preprocessing.py
"""Script to verify and visualize the EEG preprocessing pipeline.

Loads raw data, applies filtering (band-pass & notch), baseline correction, 
and channel scaling, then saves a before/after visual comparison.
"""

import os
import sys
import pathlib
import numpy as np
import matplotlib.pyplot as plt
from scipy.signal import welch

# Ensure the parent directory is in python path to load our local packages
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

from workload_classifier.utils.data_loader import load_data, FS
from workload_classifier.preprocessing.filter import preprocess, bandpass_filter, notch_filter, baseline_correction, channel_scaling

def plot_comparison(raw_signal, clean_signal, raw_psd_f, raw_psd_val, clean_psd_f, clean_psd_val, out_path):
    fig, axes = plt.subplots(2, 1, figsize=(10, 8))
    
    # 1. Time domain trace comparison
    t = np.arange(len(raw_signal)) / FS
    # Plot first 5 seconds
    limit = int(5 * FS)
    
    axes[0].plot(t[:limit], raw_signal[:limit], label="Raw Signal", color="gray", alpha=0.7)
    axes[0].plot(t[:limit], clean_signal[:limit], label="Preprocessed Signal", color="blue", linewidth=1.5)
    axes[0].set_xlabel("Time (seconds)")
    axes[0].set_ylabel("Amplitude (µV)")
    axes[0].set_title("EEG Time Domain Comparison (Subject 1, Channel 1 - First 5s)")
    axes[0].legend()
    axes[0].grid(True, linestyle="--", alpha=0.5)
    
    # 2. Frequency domain PSD comparison
    axes[1].semilogy(raw_psd_f, raw_psd_val, label="Raw PSD", color="gray", alpha=0.7)
    axes[1].semilogy(clean_psd_f, clean_psd_val, label="Preprocessed PSD", color="blue", linewidth=1.5)
    axes[1].set_xlabel("Frequency (Hz)")
    axes[1].set_ylabel("Power Spectral Density (V²/Hz)")
    axes[1].set_title("EEG Frequency Domain Comparison (Power Spectral Density)")
    axes[1].set_xlim(0.5, 60)
    axes[1].legend()
    axes[1].grid(True, which="both", linestyle="--", alpha=0.5)
    
    plt.tight_layout()
    plt.savefig(out_path, dpi=150)
    plt.close()

def main():
    print("Loading raw STEW dataset...")
    X, _, _, _ = load_data()
    
    # Select first subject, first channel for demonstration
    raw_subj_ch = X[0, 0]
    
    print("\nApplying preprocessing pipeline step-by-step...")
    # Step 1: Bandpass filter 1-45 Hz
    bp_data = bandpass_filter(X)
    # Step 2: Notch filter 50 Hz
    notch_data = notch_filter(bp_data)
    # Step 3: Baseline correction
    bc_data = baseline_correction(notch_data)
    # Step 4: Channel scaling
    clean_data = channel_scaling(bc_data)
    
    # Get preprocessed sample channel
    clean_subj_ch = clean_data[0, 0]
    
    # Print statistics comparison
    print("\n" + "="*50)
    print("        PREPROCESSING PIPELINE STATISTICAL COMPARISON")
    print("="*50)
    print(f"Raw Signal (Subj 1, Ch 1)      - Mean: {raw_subj_ch.mean():.4f}, Std: {raw_subj_ch.std():.4f}, Min: {raw_subj_ch.min():.4f}, Max: {raw_subj_ch.max():.4f}")
    print(f"Preprocessed (Subj 1, Ch 1)    - Mean: {clean_subj_ch.mean():.4f}, Std: {clean_subj_ch.std():.4f}, Min: {clean_subj_ch.min():.4f}, Max: {clean_subj_ch.max():.4f}")
    print("-"*50)
    
    # Compute PSDs
    raw_f, raw_pxx = welch(raw_subj_ch, fs=FS, nperseg=512)
    clean_f, clean_pxx = welch(clean_subj_ch, fs=FS, nperseg=512)
    
    # Save comparison visualization
    out_dir = pathlib.Path(__file__).resolve().parents[1] / "plots"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "preprocessing_comparison.png"
    
    print(f"Saving comparison plots to {out_path}...")
    plot_comparison(raw_subj_ch, clean_subj_ch, raw_f, raw_pxx, clean_f, clean_pxx, out_path)
    print("Preprocessing verification complete!")

if __name__ == "__main__":
    main()
