# run_preprocessing.py
"""Pipeline execution script for STEW dataset preprocessing.

Loads the raw dataset, runs it through the preprocessing pipeline with proper
scientific settings, validates shapes and numbers, and saves the cleaned
data tensor. Also generates before/after plots to evaluate the signal quality improvement.
"""

import os
import sys
import pathlib
import numpy as np

# Ensure parent directory is in python path to load local packages
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

from workload_classifier.utils.data_loader import load_data, FS
from workload_classifier.preprocessing.pipeline import preprocess_dataset, PreprocessingConfig
from workload_classifier.preprocessing.visualize import plot_timeseries_comparison, plot_psd_comparison


def main():
    print("=" * 60)
    print("        EEG PREPROCESSING PIPELINE – STEW DATASET")
    print("=" * 60)

    # 1. Load the raw dataset directly from MAT-files
    print("Step 1: Loading raw dataset from MAT-files...")
    try:
        X_raw, y_binary, y_three, subject_ids = load_data()
    except Exception as e:
        print(f"Error loading STEW dataset: {e}")
        sys.exit(1)
        
    print(f"Raw data tensor loaded successfully. Shape: {X_raw.shape}")
    print(f"Sampling frequency: {FS} Hz")
    
    # 2. Initialize Preprocessing Configuration
    # Uses our scientifically justified defaults:
    # 1.0 - 40.0 Hz bandpass, 50 Hz notch, Common Average Reference (CAR),
    # Z-score standardization, preserving the full 150s recordings.
    config = PreprocessingConfig()
    print("\nStep 2: Initializing preprocessing settings:")
    print(f"  - Sampling Rate   : Keep original {FS} Hz")
    print(f"  - Band-pass filter: {config.lowcut} Hz - {config.highcut} Hz (4th-order Butterworth)")
    print(f"  - Notch filter    : {config.notch_freq} Hz (Q={config.notch_q})")
    print(f"  - Re-referencing  : {'Common Average Reference (CAR)' if config.apply_car else 'None'}")
    print(f"  - Experimental ICA: {'Enabled' if config.apply_ica else 'Disabled (baseline standard)'}")
    print(f"  - Baseline Correct: {config.apply_baseline}")
    print(f"  - Scaling/Z-score : {config.apply_scaling}")
    print(f"  - Epoch Duration  : Keep continuous 150 seconds (no segmentation)")

    # 3. Execute the pipeline
    print("\nStep 3: Executing preprocessing pipeline...")
    X_clean = preprocess_dataset(X_raw, config)
    print("Pipeline executed successfully!")

    # 4. Perform dataset validation and numerical checks
    print("\nStep 4: Validating processed dataset...")
    # Assertion 1: Shape check
    assert X_clean.shape == X_raw.shape, \
        f"Shape mismatch! Expected {X_raw.shape}, got {X_clean.shape}"
    print(f"  [PASSED] Output shape matches input shape: {X_clean.shape}")
    
    # Assertion 2: Finiteness
    assert np.all(np.isfinite(X_clean)), \
        "Data contains NaNs or Infs!"
    print("  [PASSED] Clean data is finite (no NaNs or Infs)")

    # Assertion 3: Baseline correction (zero-mean) check
    # The mean across the time axis (axis=-1) for each channel and epoch should be close to 0
    mean_check = np.mean(X_clean, axis=-1)
    max_mean = np.max(np.abs(mean_check))
    print(f"  - Maximum channel/epoch mean: {max_mean:.2e} (Expected: ~0)")
    assert max_mean < 1e-10, "Mean check failed! Channel mean not close to zero."
    print("  [PASSED] Baseline correction (zero-mean per channel/epoch)")

    # Assertion 4: Scaling (unit variance) check
    # Standard deviation across the time axis (axis=-1) for each channel and epoch should be 1
    std_check = np.std(X_clean, axis=-1)
    max_std_diff = np.max(np.abs(std_check - 1.0))
    print(f"  - Maximum channel/epoch std difference from 1.0: {max_std_diff:.2e} (Expected: ~0)")
    assert max_std_diff < 1e-10, "Scaling check failed! Channel standard deviation not 1.0."
    print("  [PASSED] Standardization (unit variance per channel/epoch)")

    # 5. Generate and save before/after plots
    print("\nStep 5: Generating visualisations...")
    plot_dir = pathlib.Path(__file__).resolve().parents[1] / "plots" / "preprocessing"
    
    # Time-series comparison plot (Subject 1, Channel 1 'AF3')
    plot_timeseries_comparison(
        X_raw, X_clean,
        fs=FS,
        epoch_idx=0,
        channel_idx=0,
        channel_name="AF3",
        save_path=str(plot_dir / "timeseries_comparison_af3.png")
    )
    
    # PSD comparison plot (Averaged over all channels/subjects)
    plot_psd_comparison(
        X_raw, X_clean,
        fs=FS,
        save_path=str(plot_dir / "psd_comparison.png")
    )
    
    # 6. Save clean dataset
    # We will save the clean tensor and metadata under workload_classifier/data/stew/
    data_dir = pathlib.Path(__file__).resolve().parents[1] / "data" / "stew"
    clean_data_path = data_dir / "clean_dataset.npy"
    print(f"\nStep 6: Saving preprocessed data tensor to {clean_data_path}...")
    np.save(clean_data_path, X_clean)
    
    print("\n" + "=" * 60)
    print("       PREPROCESSING COMPLETED & VALIDATED SUCCESSFULLY")
    print("=" * 60)


if __name__ == "__main__":
    main()
