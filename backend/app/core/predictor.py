# app/core/predictor.py
"""Workload Predictor Service.

Handles loading of the optimized EEG classifier model, raw EEG preprocessing,
feature extraction, feature optimization projection, and workload classification.
Supports simulation of raw EEG recordings directly from the STEW dataset.
"""

import sys
import pathlib
import time
import json
import logging
import numpy as np
import joblib
from typing import Tuple, Dict, Any, List, Optional

# Ensure project root is in sys.path
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[3]))

from workload_classifier.preprocessing.pipeline import preprocess_dataset, PreprocessingConfig
from workload_classifier.extractor import extract_all_features
from workload_classifier.utils.data_loader import load_data, N_CHANNELS

logger = logging.getLogger("app.core.predictor")

class WorkloadPredictor:
    _instance = None

    def __new__(cls, *args, **kwargs):
        if not cls._instance:
            cls._instance = super(WorkloadPredictor, cls).__new__(cls, *args, **kwargs)
            cls._instance._initialized = False
        return cls._instance

    def __init__(self):
        if self._initialized:
            return
        
        # Paths to serialized assets
        self.classifier_dir = pathlib.Path(__file__).resolve().parents[3] / "workload_classifier" / "data" / "stew"
        self.model_path = self.classifier_dir / "best_model_optimized.joblib"
        self.manifest_path = self.classifier_dir / "selected_features.json"
        
        self.model = None
        self.manifest = None
        self.selected_indices = []
        self.method = "PCA"
        
        # Load model and manifest
        try:
            if self.model_path.is_file():
                self.model = joblib.load(self.model_path)
                logger.info(f"EEG optimized classifier loaded successfully from {self.model_path}")
            else:
                logger.error(f"Optimized model file not found at {self.model_path}")
                
            if self.manifest_path.is_file():
                with open(self.manifest_path, "r") as f:
                    self.manifest = json.load(f)
                self.selected_indices = self.manifest.get("selected_indices", [])
                self.method = self.manifest.get("method", "PCA")
                logger.info(f"Loaded selected features manifest. Method: {self.method}, K: {self.manifest.get('k_features')}")
            else:
                logger.error(f"Selected features manifest not found at {self.manifest_path}")
                
        except Exception as e:
            logger.exception("Failed to initialize WorkloadPredictor service")
            
        # Cache for raw data simulation (loaded on demand)
        self.raw_X = None
        self.raw_y_three = None
        self._initialized = True

    def is_loaded(self) -> bool:
        return self.model is not None and self.manifest is not None

    def load_simulation_data(self):
        """Lazy load raw STEW EEG dataset for real-time simulation."""
        if self.raw_X is None:
            try:
                logger.info("Loading raw STEW dataset for real-time EEG simulation...")
                self.raw_X, _, self.raw_y_three, _ = load_data()
                logger.info(f"Raw dataset loaded. Shape: {self.raw_X.shape}")
            except Exception as e:
                logger.exception("Failed to load raw STEW dataset for simulation")

    def simulate_eeg_recording(self, target_class: Optional[int] = None) -> Tuple[List[List[float]], int]:
        """Simulate a raw 10-second (1280 samples) EEG recording from the dataset.

        Returns
        -------
        Tuple[List[List[float]], int]
            2D array representing raw signals (14, 1280) and the ground truth class.
        """
        self.load_simulation_data()
        if self.raw_X is None:
            raise RuntimeError("Simulation raw data is not loaded.")
            
        n_epochs = self.raw_X.shape[0]
        
        # Filter epochs by target class if provided
        if target_class is not None:
            matching_idx = np.where(self.raw_y_three == target_class)[0]
            if len(matching_idx) == 0:
                raise ValueError(f"No epochs found with ground truth class {target_class}")
            epoch_idx = np.random.choice(matching_idx)
        else:
            epoch_idx = np.random.randint(0, n_epochs)
            
        ground_truth = int(self.raw_y_three[epoch_idx])
        
        # Slice a random 10-second segment (1280 samples at 128 Hz)
        n_samples = self.raw_X.shape[2]
        segment_len = 1280
        start_sample = np.random.randint(0, n_samples - segment_len)
        
        raw_segment = self.raw_X[epoch_idx, :, start_sample:start_sample+segment_len]
        return raw_segment.tolist(), ground_truth

    def predict_workload(self, raw_eeg: List[List[float]]) -> Dict[str, Any]:
        """Runs the raw EEG recording through the full BCI inference pipeline.

        Raw EEG (14, 1280)
        ↓
        Preprocessing (Bandpass, Notch, CAR, Zero-Mean, Unit-Variance)
        ↓
        Feature Extraction (Time-Frequency Features, shape (1, 182))
        ↓
        Feature Optimization (Slicing or PCA mapping, shape (1, K))
        ↓
        Optimized Classifier (predict_proba)
        ↓
        Predicted Workload Level & Confidence Score

        Returns
        -------
        Dict[str, Any]
            Contains: workload ("LOW", "MEDIUM", "HIGH"), confidence (0.0 to 1.0), and processing_time_ms.
        """
        t_start = time.perf_counter()
        
        if not self.is_loaded():
            raise RuntimeError("BCI optimized classifier and selected features are not loaded.")
            
        # Convert to numpy array
        eeg_np = np.array(raw_eeg, dtype=float)
        
        # Validate dimensions
        if eeg_np.ndim != 2:
            raise ValueError(f"EEG recording must be a 2D array, got {eeg_np.ndim}D")
        if eeg_np.shape[0] != N_CHANNELS:
            raise ValueError(f"EEG recording must have exactly {N_CHANNELS} channels, got {eeg_np.shape[0]}")
            
        n_samples = eeg_np.shape[1]
        
        # Enforce exactly 1280 samples (10 seconds)
        if n_samples < 1280:
            # Pad with zero-mean noise or edge repetition
            pad_len = 1280 - n_samples
            eeg_np = np.pad(eeg_np, ((0, 0), (0, pad_len)), mode="edge")
        elif n_samples > 1280:
            eeg_np = eeg_np[:, :1280]
            
        # 1. Preprocessing (Standard Singapore mains 50Hz notch, 1-40Hz bandpass, CAR, zero-mean, unit-variance)
        # Reshape to (1, 14, 1280) for preprocessing pipeline
        X_epoch = np.expand_dims(eeg_np, axis=0)
        config = PreprocessingConfig(lowcut=1.0, highcut=40.0, apply_notch=True, notch_freq=50.0)
        X_clean = preprocess_dataset(X_epoch, config)
        
        # 2. Feature Extraction (13 features/channel * 14 channels = 182 features)
        X_feats = extract_all_features(X_clean)  # returns shape (1, 182)
        
        # 3. Feature Optimization & Prediction
        if self.method != "PCA":
            # Slice features to selected subset before passing to pipeline
            X_opt = X_feats[:, self.selected_indices]
        else:
            # PCA is inside the pipeline, pass all features
            X_opt = X_feats
            
        # Run inference
        probs = self.model.predict_proba(X_opt)[0]  # probabilities for [Normal, High]
        prob_high = float(probs[1])
        
        # 4. Map binary probability to 3-level workload class (LOW, MEDIUM, HIGH)
        # Scientific Rationale:
        # - High confidence of Normal workload (prob_high < 0.35) -> LOW workload
        # - Boundary ambiguity (0.35 <= prob_high <= 0.65) -> MEDIUM workload
        # - High confidence of High workload (prob_high > 0.65) -> HIGH workload
        if prob_high < 0.35:
            workload = "LOW"
            # Scale confidence from [0.0, 0.35] to [1.0, 0.5]
            confidence = 1.0 - prob_high
        elif prob_high > 0.65:
            workload = "HIGH"
            # Scale confidence from [0.65, 1.0] to [0.5, 1.0]
            confidence = prob_high
        else:
            workload = "MEDIUM"
            # Certainty is highest near 0.5 (midpoint of transition state)
            confidence = 1.0 - 2.0 * abs(prob_high - 0.5)
            
        t_elapsed = (time.perf_counter() - t_start) * 1000.0  # in milliseconds
        
        logger.info(f"BCI prediction completed in {t_elapsed:.2f} ms. P(High)={prob_high:.4f} -> Workload: {workload} (Conf: {confidence:.2f})")
        
        return {
            "workload": workload,
            "confidence": round(confidence, 2),
            "processing_time_ms": round(t_elapsed, 2)
        }

# Initialize shared singleton instance
predictor = WorkloadPredictor()
