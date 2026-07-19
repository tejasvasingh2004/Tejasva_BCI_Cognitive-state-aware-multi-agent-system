# explore_dataset.py
"""Exploratory analysis of the STEW EEG workload dataset.

Loads the original MAT-files, prints key statistics, validates shapes,
and generates plots under `workload_classifier/analysis/plots/`.
"""

import os
import sys
import pathlib
import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
import seaborn as sns

# Ensure the parent directory is in python path to load our local packages
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

from workload_classifier.utils.data_loader import load_data, FS, N_CHANNELS, N_SUBJECTS_INCLUDED

def plot_class_distribution(y_three, out_path):
    class_counts = pd.Series(y_three).value_counts().sort_index()
    # Map class labels to string names for visual clarity
    class_names = {0: "Normal (0)", 1: "Moderate (1)", 2: "High (2)"}
    df = pd.DataFrame({
        "Workload Class": [class_names[c] for c in class_counts.index],
        "Count": class_counts.values
    })
    plt.figure(figsize=(6, 4))
    sns.barplot(x="Workload Class", y="Count", data=df, palette="viridis")
    plt.xlabel("Workload Class")
    plt.ylabel("Number of Subjects / Epochs")
    plt.title("STEW Three-Class Workload Distribution")
    plt.grid(axis='y', linestyle='--', alpha=0.7)
    plt.tight_layout()
    plt.savefig(out_path, dpi=150)
    plt.close()

def plot_example_epoch(X, out_path):
    # Take first subject's epoch, shape (14, 19200)
    epoch = X[0]
    times = np.arange(epoch.shape[1]) / FS
    
    # Plot first 10 seconds for visual clarity
    max_time_idx = int(10 * FS)
    
    plt.figure(figsize=(12, 6))
    for ch in range(epoch.shape[0]):
        plt.plot(times[:max_time_idx], epoch[ch, :max_time_idx] + ch * 150, label=f"Ch {ch+1}")
    
    plt.xlabel("Time (seconds)")
    plt.ylabel("EEG Amplitude + offset (µV)")
    plt.title("Sample Raw EEG Signal (First 10s of Subject 1)")
    plt.legend(bbox_to_anchor=(1.01, 1), loc="upper left", fontsize="small")
    plt.grid(True, linestyle='--', alpha=0.5)
    plt.tight_layout()
    plt.savefig(out_path, dpi=150)
    plt.close()

def plot_average_psd(X, out_path):
    from scipy.signal import welch
    
    # Calculate PSD per channel, per epoch
    psds = []
    for epoch in X:
        for ch in range(N_CHANNELS):
            f, pxx = welch(epoch[ch], fs=FS, nperseg=512)
            psds.append(pxx)
            
    avg_psd = np.mean(psds, axis=0)
    
    plt.figure(figsize=(8, 4))
    plt.semilogy(f, avg_psd, color='darkred', linewidth=2)
    plt.xlabel("Frequency (Hz)")
    plt.ylabel("PSD (V²/Hz)")
    plt.title("Average Power Spectral Density (All Subjects & Channels)")
    plt.grid(True, which="both", linestyle="--", alpha=0.5)
    plt.xlim(0.5, 60)  # Standard EEG frequencies of interest
    plt.tight_layout()
    plt.savefig(out_path, dpi=150)
    plt.close()

def main():
    try:
        X, y_binary, y_three, subject_ids = load_data()
    except Exception as e:
        print(f"Error loading STEW dataset: {e}")
        return

    print("\n" + "="*50)
    print("      STEW DATASET SUMMARY (VALIDATED FROM .MAT SOURCE)")
    print("="*50)
    print(f"Primary EEG Tensor Shape  : {X.shape} (N_Subjects, N_Channels, N_Samples)")
    print(f"Sampling Frequency (Fs)   : {FS} Hz")
    print(f"Total Channels            : {N_CHANNELS}")
    print(f"Recording Duration        : {X.shape[2] / FS:.1f} seconds ({X.shape[2] / (FS*60):.1f} minutes)")
    print(f"Total Included Subjects   : {N_SUBJECTS_INCLUDED} (Subjects 5, 24, 42 excluded)")
    print("-"*50)
    print("CLASS DISTRIBUTION (Three-Class workload):")
    unique_3, counts_3 = np.unique(y_three, return_counts=True)
    class_names = {0: "Normal workload", 1: "Moderate workload", 2: "High workload"}
    for u, c in zip(unique_3, counts_3):
        print(f"  Class {u} ({class_names[u]:<18}): {c} subjects ({c/N_SUBJECTS_INCLUDED*100:.1f}%)")
        
    print("\nCLASS DISTRIBUTION (Binary workload):")
    unique_2, counts_2 = np.unique(y_binary, return_counts=True)
    binary_names = {0: "Normal workload", 1: "High workload"}
    for u, c in zip(unique_2, counts_2):
        print(f"  Class {u} ({binary_names[u]:<18}): {c} subjects ({c/N_SUBJECTS_INCLUDED*100:.1f}%)")
    print("="*50 + "\n")

    # Create output directory for plots
    out_dir = pathlib.Path(__file__).resolve().parents[1] / "plots"
    out_dir.mkdir(parents=True, exist_ok=True)
    
    print(f"Generating visualisations in: {out_dir} ...")
    plot_class_distribution(y_three, out_dir / "class_distribution.png")
    plot_example_epoch(X, out_dir / "example_epoch.png")
    plot_average_psd(X, out_dir / "channel_psd.png")
    print("Plots generated successfully!")

if __name__ == "__main__":
    main()
