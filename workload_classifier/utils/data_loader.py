# utils/data_loader.py
"""Data loader for STEW EEG dataset.

Loads the original MATLAB (.mat) files directly from the local cache directory,
validates the dimensions against the official STEW metadata, maps the
epochs to their respective subjects and workload levels, and returns raw signals.
"""

import pathlib
from typing import Tuple
import numpy as np
import scipy.io as sio

# =====================================================================
# STEW Dataset Verified Constants
# Source: Wei Lun Lim, Olga Sourina, Lipo Wang, July 10, 2018,
# "STEW: Simultaneous Task EEG Workload Dataset", IEEE Dataport.
# =====================================================================
FS = 128  # Sampling frequency in Hz
N_CHANNELS = 14  # Emotiv EPOC standard EEG channels
EPOCH_DURATION_SEC = 150  # 2.5 minutes per recording
N_SAMPLES_PER_EPOCH = 19200  # FS * EPOCH_DURATION_SEC = 128 * 150
TOTAL_SUBJECTS_RECORDED = 48

# Excluded subjects due to missing subjective ratings in the official STEW dataset:
# Subject 5, Subject 24, and Subject 42.
EXCLUDED_SUBJECTS = {5, 24, 42}
N_SUBJECTS_INCLUDED = TOTAL_SUBJECTS_RECORDED - len(EXCLUDED_SUBJECTS)  # 45

# Ground truth workload label mapping (Three-class):
# Class 0: Normal workload (Subjective rating 4 or 5)
# Class 1: Moderate workload (Subjective rating 6 or 7)
# Class 2: High workload (Subjective rating 8 or 9)
THREE_CLASS_MAPPING = {
    4: 0, 5: 0,
    6: 1, 7: 1,
    8: 2, 9: 2
}

# Ground truth workload label mapping (Two-class / Binary):
# Class 0: Normal workload (Subjective rating 4, 5, or 6)
# Class 1: High workload (Subjective rating 7, 8, or 9)
TWO_CLASS_MAPPING = {
    4: 0, 5: 0, 6: 0,
    7: 1, 8: 1, 9: 1
}

# Directory containing the dataset files
CACHE_DIR = pathlib.Path(__file__).resolve().parents[2] / "workload_classifier" / "data" / "stew"


def get_subject_list() -> np.ndarray:
    """Returns the ordered list of subject IDs included in the dataset.

    Subjects 5, 24, and 42 are excluded due to missing ratings.
    """
    all_subjects = np.arange(1, TOTAL_SUBJECTS_RECORDED + 1)
    included = [s for s in all_subjects if s not in EXCLUDED_SUBJECTS]
    return np.array(included, dtype=int)


def load_data(binary_scheme: str = "paper") -> Tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Load EEG data, ratings, and workload labels from original MATLAB files.

    Parameters
    ----------
    binary_scheme : str, default="paper"
        Defines how binary workload labels are derived from the 1-9 rating scale.
        - "paper": Class 0 = ratings 4-6 (Normal), Class 1 = ratings 7-9 (High).
        - "threshold": Class 0 = ratings 4-5 (Normal), Class 1 = ratings 6-9 (Moderate/High).

    Returns
    -------
    X : np.ndarray, shape (45, 14, 19200)
        EEG signal epochs. Permuted to (n_epochs, n_channels, n_times).
    y_binary : np.ndarray, shape (45,)
        Binary workload labels (0 or 1).
    y_three : np.ndarray, shape (45,)
        Three-class workload labels (0 = Normal, 1 = Moderate, 2 = High).
    subject_ids : np.ndarray, shape (45,)
        Subject ID associated with each epoch (1-48, skipping 5, 24, 42).
    """
    # 1. Resolve file paths
    dataset_path = CACHE_DIR / "dataset.mat"
    rating_path = CACHE_DIR / "rating.mat"
    class_path = CACHE_DIR / "class_012.mat"

    if not dataset_path.is_file():
        raise FileNotFoundError(f"Missing primary dataset file: {dataset_path}")
    if not rating_path.is_file():
        raise FileNotFoundError(f"Missing rating file: {rating_path}")
    if not class_path.is_file():
        raise FileNotFoundError(f"Missing class file: {class_path}")

    # 2. Load MATLAB structures
    # dataset.mat contains key 'dataset' with shape (14, 19200, 45)
    raw_dataset = sio.loadmat(str(dataset_path))["dataset"]
    # rating.mat contains key 'rating' with shape (45, 1)
    raw_rating = sio.loadmat(str(rating_path))["rating"].flatten()
    # class_012.mat contains key 'class_012' with shape (45, 1)
    raw_class_012 = sio.loadmat(str(class_path))["class_012"].flatten()

    # 3. Permute EEG data to standard shape: (n_epochs, n_channels, n_times)
    # Original shape: (14, 19200, 45) -> Permuted shape: (45, 14, 19200)
    X = np.transpose(raw_dataset, (2, 0, 1))

    # 4. Perform structural validation
    assert X.shape == (N_SUBJECTS_INCLUDED, N_CHANNELS, N_SAMPLES_PER_EPOCH), \
        f"EEG shape mismatch: Expected {(N_SUBJECTS_INCLUDED, N_CHANNELS, N_SAMPLES_PER_EPOCH)}, got {X.shape}"
    assert len(raw_rating) == N_SUBJECTS_INCLUDED, \
        f"Rating size mismatch: Expected {N_SUBJECTS_INCLUDED}, got {len(raw_rating)}"
    assert len(raw_class_012) == N_SUBJECTS_INCLUDED, \
        f"Class size mismatch: Expected {N_SUBJECTS_INCLUDED}, got {len(raw_class_012)}"

    # 5. Extract subject IDs and map labels
    subject_ids = get_subject_list()

    # Verify ratings are in the expected 4-9 range for multitasking
    if not np.all((raw_rating >= 4) & (raw_rating <= 9)):
        raise ValueError(f"Ratings out of range 4-9: {np.unique(raw_rating)}")

    # Map ratings to three-class and binary labels
    y_three = np.array([THREE_CLASS_MAPPING[r] for r in raw_rating], dtype=int)
    
    # Verify our calculated y_three matches class_012.mat
    if not np.array_equal(y_three, raw_class_012):
        raise ValueError("Computed three-class labels do not match class_012.mat!")

    # Derive binary labels based on selected scheme
    if binary_scheme == "paper":
        y_binary = np.array([TWO_CLASS_MAPPING[r] for r in raw_rating], dtype=int)
    elif binary_scheme == "threshold":
        y_binary = (y_three > 0).astype(int)
    else:
        raise ValueError(f"Unknown binary_scheme: {binary_scheme}")

    return X, y_binary, y_three, subject_ids


if __name__ == "__main__":
    X, y_bin, y_thr, subjs = load_data()
    print("=== STEW Data Validation Success ===")
    print(f"X shape: {X.shape}")
    print(f"y_binary shape: {y_bin.shape} (unique values: {np.unique(y_bin)})")
    print(f"y_three shape: {y_thr.shape} (unique values: {np.unique(y_thr)})")
    print(f"Subject IDs: {subjs}")

