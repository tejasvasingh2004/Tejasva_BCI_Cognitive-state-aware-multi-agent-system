# classifier.py
"""Model training and evaluation module for STEW EEG workload dataset.

Trains, tunes, and compares multiple machine learning classifiers (Logistic Regression,
SVM, Random Forest, XGBoost, and LightGBM) using strictly subject-grouped 5-fold
cross-validation to prevent data leakage. Saves serialized models and validation logs.
"""

import sys
import pathlib
import json
import numpy as np
import pandas as pd
import joblib
from typing import Tuple, Dict, Any, List

from sklearn.model_selection import GroupKFold, GridSearchCV
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import Pipeline
from sklearn.metrics import (
    accuracy_score,
    balanced_accuracy_score,
    precision_score,
    recall_score,
    f1_score,
    roc_auc_score,
    confusion_matrix
)
from sklearn.linear_model import LogisticRegression
from sklearn.ensemble import RandomForestClassifier
from sklearn.svm import SVC
from xgboost import XGBClassifier
from lightgbm import LGBMClassifier

# Ensure parent directory is in sys.path for local module imports
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from workload_classifier.extractor import load_features


def analyze_class_distribution(y: np.ndarray, label_type: str = "Binary") -> Dict[str, Any]:
    """Analyze the class distribution and calculate imbalance ratios.

    Scientific Justification:
    - Identifying class imbalance is critical to select appropriate evaluation metrics
      (e.g., Balanced Accuracy, F1-macro) and balancing strategies (e.g. cost-sensitive weights).
    """
    classes, counts = np.unique(y, return_counts=True)
    total = len(y)
    
    print(f"\n--- {label_type} Class Distribution Analysis ---")
    class_info = {}
    for c, count in zip(classes, counts):
        percentage = (count / total) * 100
        print(f"  Class {c}: {count} samples ({percentage:.2f}%)")
        class_info[str(c)] = {
            "count": int(count),
            "percentage": float(percentage)
        }
        
    imbalance_ratio = np.max(counts) / np.min(counts)
    print(f"  Imbalance Ratio (Max/Min): {imbalance_ratio:.2f}")
    
    # Guidelines: Ratio < 1.5 is generally considered balanced, so simple scaling is sufficient.
    if imbalance_ratio > 1.5:
        print("  [Note] Moderate class imbalance detected. Cost-sensitive weight tuning will be applied.")
    else:
        print("  [Note] Dataset is relatively balanced. Standard loss metrics and mild weighting are suitable.")
        
    return {
        "class_counts": class_info,
        "imbalance_ratio": float(imbalance_ratio)
    }


def get_model_grid(model_name: str, n_classes: int) -> Tuple[Pipeline, Dict[str, List[Any]]]:
    """Retrieve the pipeline and hyperparameter grid for a given model.

    Mathematical Intuition & EEG Suitability:
    - LogisticRegression (L2): Serves as a linear baseline. L2 regularization prevents overfitting
      in the presence of multi-collinear EEG band powers.
    - SVM (RBF): Maps features into a high-dimensional space. The radial basis function (RBF)
      is highly suitable for capturing non-linear threshold boundaries between workload levels.
    - RandomForest: An ensemble of decision trees. Robust to outliers and provides built-in feature
      importance by measuring impurity reduction.
    - XGBoost: Uses gradient boosting with regularized learning objectives (L1/L2) to prevent overfitting
      and capture complex time-frequency interactions.
    - LightGBM: Leaf-wise tree growth enables fast convergence and high accuracy on tabular features.
    """
    # 1. Base Classifiers
    if model_name == "LogisticRegression":
        clf = LogisticRegression(max_iter=2000, class_weight="balanced", random_state=42)
        param_grid = {"classifier__C": [0.1, 1.0]}
        
    elif model_name == "SVM_RBF":
        # probability=True is required to output probabilities for ROC-AUC calculation
        clf = SVC(kernel="rbf", probability=True, class_weight="balanced", random_state=42)
        param_grid = {
            "classifier__C": [1.0, 10.0],
            "classifier__gamma": ["scale", 0.1]
        }
        
    elif model_name == "RandomForest":
        clf = RandomForestClassifier(class_weight="balanced", random_state=42)
        param_grid = {
            "classifier__n_estimators": [100],
            "classifier__max_depth": [10, None]
        }
        
    elif model_name == "XGBoost":
        # XGBoost requires class weights via sample_weight or scale_pos_weight for binary
        clf = XGBClassifier(random_state=42, eval_metric="logloss")
        param_grid = {
            "classifier__n_estimators": [100],
            "classifier__max_depth": [3, 5]
        }
        
    elif model_name == "LightGBM":
        clf = LGBMClassifier(class_weight="balanced", random_state=42, verbose=-1)
        param_grid = {
            "classifier__n_estimators": [100],
            "classifier__max_depth": [3, -1]
        }
    else:
        raise ValueError(f"Unknown model name: {model_name}")

    # Build Pipeline: StandardScaler must be fitted inside CV folds to prevent scaling leakage
    pipe = Pipeline([
        ("scaler", StandardScaler()),
        ("classifier", clf)
    ])
    
    return pipe, param_grid


def evaluate_tuned_model(
    X: np.ndarray,
    y: np.ndarray,
    groups: np.ndarray,
    model_name: str,
    best_params: Dict[str, Any],
    n_classes: int
) -> Dict[str, Any]:
    """Perform a rigorous 5-fold GroupKFold evaluation using the tuned hyperparameters.

    Collects predictions, probabilities, and compute fold-wise metrics.
    """
    gkf = GroupKFold(n_splits=5)
    
    # Re-initialize pipe with best parameters
    pipe, _ = get_model_grid(model_name, n_classes)
    pipe.set_params(**best_params)
    
    accs, bal_accs, precs, recs, f1s, rocs = [], [], [], [], [], []
    oof_preds = np.zeros_like(y)
    # Shape of probabilities: (n_samples, n_classes)
    oof_probs = np.zeros((len(y), n_classes))
    
    for fold, (train_idx, test_idx) in enumerate(gkf.split(X, y, groups=groups)):
        X_train, X_test = X[train_idx], X[test_idx]
        y_train, y_test = y[train_idx], y[test_idx]
        
        # Fit on training fold
        pipe.fit(X_train, y_train)
        
        # Predict classes and probabilities
        preds = pipe.predict(X_test)
        probs = pipe.predict_proba(X_test)
        
        oof_preds[test_idx] = preds
        oof_probs[test_idx] = probs
        
        # Compute fold metrics
        accs.append(accuracy_score(y_test, preds))
        bal_accs.append(balanced_accuracy_score(y_test, preds))
        
        if n_classes == 2:
            precs.append(precision_score(y_test, preds, zero_division=0))
            recs.append(recall_score(y_test, preds, zero_division=0))
            f1s.append(f1_score(y_test, preds, zero_division=0))
            rocs.append(roc_auc_score(y_test, probs[:, 1]))
        else:
            precs.append(precision_score(y_test, preds, average="macro", zero_division=0))
            recs.append(recall_score(y_test, preds, average="macro", zero_division=0))
            f1s.append(f1_score(y_test, preds, average="macro", zero_division=0))
            # Multi-class ROC-AUC using One-vs-Rest (OVR)
            rocs.append(roc_auc_score(y_test, probs, multi_class="ovr", average="macro"))

    return {
        "oof_preds": oof_preds.tolist(),
        "oof_probs": oof_probs.tolist(),
        "metrics": {
            "accuracy": {"mean": float(np.mean(accs)), "std": float(np.std(accs))},
            "balanced_accuracy": {"mean": float(np.mean(bal_accs)), "std": float(np.std(bal_accs))},
            "precision": {"mean": float(np.mean(precs)), "std": float(np.std(precs))},
            "recall": {"mean": float(np.mean(recs)), "std": float(np.std(recs))},
            "f1": {"mean": float(np.mean(f1s)), "std": float(np.std(f1s))},
            "roc_auc": {"mean": float(np.mean(rocs)), "std": float(np.std(rocs))}
        }
    }


def run_modeling_suite(
    X: np.ndarray,
    y: np.ndarray,
    groups: np.ndarray,
    n_classes: int,
    label_type: str = "Binary"
) -> Tuple[Dict[str, Any], Pipeline]:
    """Train, tune, and evaluate all models in a loop."""
    model_names = ["LogisticRegression", "SVM_RBF", "RandomForest", "XGBoost", "LightGBM"]
    results = {}
    best_f1 = -1.0
    best_pipe = None
    best_model_name = ""
    best_params_global = {}

    gkf = GroupKFold(n_splits=5)

    for name in model_names:
        print(f"\n>>> Tuning and evaluating: {name} ...")
        pipe, param_grid = get_model_grid(name, n_classes)
        
        # Grid search over all data using GroupKFold
        grid = GridSearchCV(pipe, param_grid, cv=gkf, scoring="accuracy", n_jobs=1)
        grid.fit(X, y, groups=groups)
        
        print(f"  Best Grid Parameters: {grid.best_params_}")
        print(f"  Grid Training CV Accuracy: {grid.best_score_:.4f}")
        
        # Perform rigorous out-of-fold evaluation with these best parameters
        eval_results = evaluate_tuned_model(X, y, groups, name, grid.best_params_, n_classes)
        
        # Log results
        results[name] = {
            "best_params": grid.best_params_,
            "metrics": eval_results["metrics"],
            "oof_preds": eval_results["oof_preds"],
            "oof_probs": eval_results["oof_probs"]
        }
        
        mean_f1 = eval_results["metrics"]["f1"]["mean"]
        print(f"  Out-of-Fold F1-score: {mean_f1:.4f} ± {eval_results['metrics']['f1']['std']:.4f}")

        # Track the best model based on F1-score
        if mean_f1 > best_f1:
            best_f1 = mean_f1
            best_model_name = name
            best_params_global = grid.best_params_
            
    print(f"\nSelect Best {label_type} Model: {best_model_name} (F1 = {best_f1:.4f})")
    
    # Train the final pipeline on all data using the best parameters
    final_pipe, _ = get_model_grid(best_model_name, n_classes)
    final_pipe.set_params(**best_params_global)
    final_pipe.fit(X, y)
    
    return results, final_pipe


def generate_ranking_table(results: Dict[str, Any], label_type: str = "Binary") -> str:
    """Generate a markdown ranking table sorted by out-of-fold F1-score without external tabulate dependency."""
    rows = []
    for model_name, res in results.items():
        m = res["metrics"]
        rows.append((
            model_name,
            m['accuracy']['mean'],
            m['accuracy']['std'],
            m['balanced_accuracy']['mean'],
            m['balanced_accuracy']['std'],
            m['f1']['mean'],
            m['f1']['std'],
            m['roc_auc']['mean'],
            m['roc_auc']['std']
        ))
        
    # Sort by F1-Score (mean) in descending order (index 5)
    rows.sort(key=lambda x: x[5], reverse=True)
    
    markdown_table = f"### Model Comparison Ranking Table ({label_type} Workload)\n\n"
    markdown_table += "| Model | Accuracy | Balanced Acc | F1-Score | ROC-AUC |\n"
    markdown_table += "| :--- | :--- | :--- | :--- | :--- |\n"
    
    for row in rows:
        model_name = row[0]
        acc = f"{row[1]:.4f} (±{row[2]:.4f})"
        bal_acc = f"{row[3]:.4f} (±{row[4]:.4f})"
        f1 = f"{row[5]:.4f} (±{row[6]:.4f})"
        roc = f"{row[7]:.4f} (±{row[8]:.4f})"
        markdown_table += f"| {model_name} | {acc} | {bal_acc} | {f1} | {roc} |\n"
        
    print("\n" + markdown_table + "\n")
    return markdown_table


def main():
    print("=" * 60)
    print("      EEG CLASSIFIER MODEL DEVELOPMENT & EVALUATION")
    print("=" * 60)

    # 1. Load preprocessed features
    X_feats, y_bin, y_three, subject_ids = load_features()
    
    # Create save paths
    model_save_dir = pathlib.Path(__file__).resolve().parents[0] / "data" / "stew"
    model_save_dir.mkdir(parents=True, exist_ok=True)
    
    # 2. Analyze class distributions
    bin_dist = analyze_class_distribution(y_bin, "Binary")
    thr_dist = analyze_class_distribution(y_three, "Three-Class")
    
    # 3. Part A: Binary Workload Classification (Normal vs. High)
    print("\n" + "=" * 50)
    print("      PART A: BINARY COGNITIVE WORKLOAD ESTIMATION")
    print("=" * 50)
    bin_results, best_bin_pipe = run_modeling_suite(X_feats, y_bin, subject_ids, n_classes=2, label_type="Binary")
    bin_table = generate_ranking_table(bin_results, "Binary")
    
    # Save best binary model
    binary_model_path = model_save_dir / "best_model_binary.joblib"
    joblib.dump(best_bin_pipe, binary_model_path)
    print(f"Saved best binary pipeline to: {binary_model_path}")
    
    # 4. Part B: Three-Class Workload Classification (Normal vs. Moderate vs. High)
    print("\n" + "=" * 50)
    print("      PART B: THREE-CLASS COGNITIVE WORKLOAD ESTIMATION")
    print("=" * 50)
    thr_results, best_thr_pipe = run_modeling_suite(X_feats, y_three, subject_ids, n_classes=3, label_type="Three-Class")
    thr_table = generate_ranking_table(thr_results, "Three-Class")
    
    # Save best three-class model
    three_class_model_path = model_save_dir / "best_model_3class.joblib"
    joblib.dump(best_thr_pipe, three_class_model_path)
    print(f"Saved best three-class pipeline to: {three_class_model_path}")
    
    # 5. Save all validation log details to evaluation_metrics.json
    metrics_log = {
        "class_distributions": {
            "binary": bin_dist,
            "three_class": thr_dist
        },
        "binary_results": {
            name: {
                "best_params": res["best_params"],
                "metrics": res["metrics"],
                "oof_preds": res["oof_preds"],
                "oof_probs": res["oof_probs"]
            } for name, res in bin_results.items()
        },
        "three_class_results": {
            name: {
                "best_params": res["best_params"],
                "metrics": res["metrics"],
                "oof_preds": res["oof_preds"],
                "oof_probs": res["oof_probs"]
            } for name, res in thr_results.items()
        },
        "ranking_tables": {
            "binary": bin_table,
            "three_class": thr_table
        }
    }
    
    with open(model_save_dir / "evaluation_metrics.json", "w") as f:
        json.dump(metrics_log, f, indent=4)
    print(f"\nSaved complete validation logs to: {model_save_dir / 'evaluation_metrics.json'}")
    
    print("\n" + "=" * 60)
    print("       MODEL TRAINING & CV EVALUATION COMPLETED SUCCESSFULLY")
    print("=" * 60)


if __name__ == "__main__":
    main()
