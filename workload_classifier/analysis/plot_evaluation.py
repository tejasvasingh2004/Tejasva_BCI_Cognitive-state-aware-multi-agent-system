# plot_evaluation.py
"""Visualisation script for evaluating trained EEG workload classifiers.

Generates publication-quality figures:
1. Confusion Matrices (Binary and Three-Class).
2. Model Comparison Bar Chart (F1-score across all 5 candidates).
3. Feature Importance Bar Chart of the best-performing tree/linear model.
4. Out-of-fold ROC Curves with fold-to-fold variance shadow.

Saves figures to `workload_classifier/plots/evaluation/`.
"""

import os
import sys
from typing import Dict, Any
import json
import pathlib
import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
import seaborn as sns

from sklearn.metrics import confusion_matrix, roc_curve, auc
from sklearn.model_selection import GroupKFold
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import Pipeline
import joblib

# Ensure parent directory is in sys.path for local module imports
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

from workload_classifier.extractor import load_features, BANDS
from workload_classifier.analysis.feature_analysis import generate_feature_names

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


def load_metrics_log() -> Dict[str, Any]:
    metrics_path = pathlib.Path(__file__).resolve().parents[1] / "data" / "stew" / "evaluation_metrics.json"
    if not metrics_path.is_file():
        raise FileNotFoundError(f"Missing evaluation metrics log: {metrics_path}. Please run classifier.py first.")
    with open(metrics_path, "r") as f:
        return json.load(f)


def plot_confusion_matrices(metrics_log: Dict[str, Any], y_bin: np.ndarray, y_three: np.ndarray, save_dir: pathlib.Path):
    """Plot confusion matrices for the best binary and three-class models based on out-of-fold predictions."""
    
    # 1. Binary Confusion Matrix
    bin_results = metrics_log["binary_results"]
    # Find best binary model name based on out-of-fold F1
    best_bin_name = max(bin_results, key=lambda k: bin_results[k]["metrics"]["f1"]["mean"])
    bin_oof_preds = np.array(bin_results[best_bin_name]["oof_preds"])
    
    cm_bin = confusion_matrix(y_bin, bin_oof_preds)
    
    # 2. Three-Class Confusion Matrix
    thr_results = metrics_log["three_class_results"]
    best_thr_name = max(thr_results, key=lambda k: thr_results[k]["metrics"]["f1"]["mean"])
    thr_oof_preds = np.array(thr_results[best_thr_name]["oof_preds"])
    
    cm_thr = confusion_matrix(y_three, thr_oof_preds)
    
    fig, axes = plt.subplots(1, 2, figsize=(14, 6))
    
    # Binary Plot
    sns.heatmap(
        cm_bin,
        annot=True,
        fmt="d",
        cmap="Blues",
        ax=axes[0],
        xticklabels=["Normal", "High"],
        yticklabels=["Normal", "High"],
        cbar=False,
        annot_kws={"size": 16, "weight": "bold"}
    )
    axes[0].set_title(f"Binary Classifier: {best_bin_name}\n(Out-of-Fold CM)", weight="bold", pad=12)
    axes[0].set_xlabel("Predicted Label")
    axes[0].set_ylabel("Actual Label")
    axes[0].grid(False)

    # Three-Class Plot
    sns.heatmap(
        cm_thr,
        annot=True,
        fmt="d",
        cmap="Blues",
        ax=axes[1],
        xticklabels=["Normal", "Moderate", "High"],
        yticklabels=["Normal", "Moderate", "High"],
        cbar=False,
        annot_kws={"size": 16, "weight": "bold"}
    )
    axes[1].set_title(f"Three-Class Classifier: {best_thr_name}\n(Out-of-Fold CM)", weight="bold", pad=12)
    axes[1].set_xlabel("Predicted Label")
    axes[1].set_ylabel("Actual Label")
    axes[1].grid(False)

    plt.tight_layout()
    plt.savefig(save_dir / "confusion_matrices.png", dpi=300, bbox_inches="tight")
    print(f"Saved confusion matrices to: {save_dir}/confusion_matrices.png")
    plt.close()


def plot_model_comparison(metrics_log: Dict[str, Any], save_dir: pathlib.Path):
    """Plot a bar chart comparing F1-scores and Accuracies of all evaluated models."""
    bin_res = metrics_log["binary_results"]
    thr_res = metrics_log["three_class_results"]
    
    models = list(bin_res.keys())
    
    # Prepare data for plotting
    plot_data = []
    for name in models:
        # Binary
        b_m = bin_res[name]["metrics"]
        plot_data.append({
            "Model": name,
            "F1-Score": b_m["f1"]["mean"],
            "Std": b_m["f1"]["std"],
            "Task": "Binary"
        })
        # Three-Class
        t_m = thr_res[name]["metrics"]
        plot_data.append({
            "Model": name,
            "F1-Score": t_m["f1"]["mean"],
            "Std": t_m["f1"]["std"],
            "Task": "Three-Class"
        })
        
    df_plot = pd.DataFrame(plot_data)

    plt.figure(figsize=(12, 6.5))
    ax = sns.barplot(
        x="Model",
        y="F1-Score",
        hue="Task",
        data=df_plot,
        palette="muted",
        edgecolor="black",
        linewidth=1
    )
    
    # Draw error bars manually
    # Since seaborn's error bar on pre-aggregated data is tricky, we can draw them on the axes
    for i, bar in enumerate(ax.patches):
        # Locate corresponding row in dataframe
        row_idx = i // 2 + (i % 2) * len(models)
        if row_idx >= len(df_plot):
            continue
        row = df_plot.iloc[row_idx]
        x_val = bar.get_x() + bar.get_width() / 2
        y_val = bar.get_height()
        error = row["Std"]
        
        ax.errorbar(
            x_val, y_val, yerr=error,
            fmt="none", c="black", capsize=5, elinewidth=1.5
        )

    plt.title("Out-of-Fold Model Comparison (Mean F1-score ± SD)", weight="bold", pad=15)
    plt.ylabel("F1-score")
    plt.xlabel("Classifier Model")
    plt.ylim(0, 1.05)
    plt.legend(title="Classification Task", loc="lower left")
    plt.tight_layout()
    plt.savefig(save_dir / "model_comparison_bar.png", dpi=300, bbox_inches="tight")
    print(f"Saved model comparison bar chart to: {save_dir}/model_comparison_bar.png")
    plt.close()


def plot_feature_importance(save_dir: pathlib.Path):
    """Plot feature importance for the best binary tree model (or weights if Logistic Regression is best)."""
    # Load the best binary pipeline
    model_dir = pathlib.Path(__file__).resolve().parents[1] / "data" / "stew"
    model_path = model_dir / "best_model_binary.joblib"
    
    if not model_path.is_file():
        print("Best binary model file not found, skipping feature importance plot.")
        return
        
    pipe = joblib.load(str(model_path))
    classifier = pipe.named_steps["classifier"]
    
    feat_names = generate_feature_names()
    
    # Check if classifier has feature importances (Tree-based)
    if hasattr(classifier, "feature_importances_"):
        importances = classifier.feature_importances_
        title = f"Top 15 Feature Importances ({type(classifier).__name__})"
        y_label = "Relative Importance"
    # Check if classifier has coefs (Logistic Regression / Linear SVM)
    elif hasattr(classifier, "coef_"):
        # For multi-class or binary, take absolute magnitude of coefficients
        importances = np.mean(np.abs(classifier.coef_), axis=0)
        title = f"Top 15 Absolute Coefficient Magnitudes ({type(classifier).__name__})"
        y_label = "Mean Absolute Weight"
    else:
        print(f"Classifier {type(classifier).__name__} does not support feature importance/coefs. Skipping.")
        return
        
    df_imp = pd.DataFrame({
        "Feature": feat_names,
        "Importance": importances
    }).sort_values(by="Importance", ascending=False).head(15)

    plt.figure(figsize=(12, 7.5))
    sns.barplot(
        x="Importance",
        y="Feature",
        data=df_imp,
        palette="viridis",
        edgecolor="black",
        linewidth=1
    )
    plt.title(title, weight="bold", pad=15)
    plt.xlabel(y_label)
    plt.ylabel("Feature Name")
    plt.tight_layout()
    plt.savefig(save_dir / "feature_importances.png", dpi=300, bbox_inches="tight")
    print(f"Saved feature importance plot to: {save_dir}/feature_importances.png")
    plt.close()


def plot_roc_curves(X: np.ndarray, y_bin: np.ndarray, groups: np.ndarray, save_dir: pathlib.Path):
    """Plot out-of-fold ROC Curves with fold-to-fold variance shadow for the best binary model."""
    model_dir = pathlib.Path(__file__).resolve().parents[1] / "data" / "stew"
    model_path = model_dir / "best_model_binary.joblib"
    
    if not model_path.is_file():
        print("Best binary model file not found, skipping ROC plot.")
        return
        
    # Load the best binary pipeline
    pipe = joblib.load(str(model_path))
    
    gkf = GroupKFold(n_splits=5)
    
    tprs = []
    aucs = []
    mean_fpr = np.linspace(0, 1, 100)

    plt.figure(figsize=(10, 8.5))
    
    for fold, (train_idx, test_idx) in enumerate(gkf.split(X, y_bin, groups=groups)):
        X_train, X_test = X[train_idx], X[test_idx]
        y_train, y_test = y_bin[train_idx], y_bin[test_idx]
        
        # Fit on fold training set
        pipe.fit(X_train, y_train)
        
        # Get probability estimates for positive class
        probs = pipe.predict_proba(X_test)[:, 1]
        
        # Compute ROC
        fpr, tpr, thresholds = roc_curve(y_test, probs)
        roc_auc = auc(fpr, tpr)
        aucs.append(roc_auc)
        
        # Interpolate TPR at standard FPR points
        interp_tpr = np.interp(mean_fpr, fpr, tpr)
        interp_tpr[0] = 0.0
        tprs.append(interp_tpr)
        
        plt.plot(fpr, tpr, lw=1, alpha=0.5, label=f"Fold {fold + 1} (AUC = {roc_auc:.2f})")

    # Plot Chance line
    plt.plot([0, 1], [0, 1], linestyle="--", lw=2, color="#d95f02", label="Chance (AUC = 0.50)", alpha=0.8)

    # Plot Mean ROC
    mean_tpr = np.mean(tprs, axis=0)
    mean_tpr[-1] = 1.0
    mean_auc = auc(mean_fpr, mean_tpr)
    std_auc = np.std(aucs)
    
    plt.plot(
        mean_fpr, mean_tpr, color="#1b9e77",
        label=f"Mean ROC (AUC = {mean_auc:.2f} ± {std_auc:.2f})",
        lw=2.5, alpha=0.9
    )

    # Plot Standard Deviation shadow
    std_tpr = np.std(tprs, axis=0)
    tprs_upper = np.minimum(mean_tpr + std_tpr, 1)
    tprs_lower = np.maximum(mean_tpr - std_tpr, 0)
    plt.fill_between(
        mean_fpr, tprs_lower, tprs_upper, color="#1b9e77", alpha=0.15,
        label="± 1 std. dev."
    )

    plt.xlim([-0.05, 1.05])
    plt.ylim([-0.05, 1.05])
    plt.xlabel("False Positive Rate")
    plt.ylabel("True Positive Rate")
    plt.title(f"Receiver Operating Characteristic (ROC) – {type(pipe.named_steps['classifier']).__name__}", weight="bold", pad=15)
    plt.legend(loc="lower right", frameon=True, facecolor="white", edgecolor="none")
    plt.grid(True, linestyle="--", alpha=0.5)
    plt.tight_layout()
    plt.savefig(save_dir / "roc_curves.png", dpi=300, bbox_inches="tight")
    print(f"Saved ROC curves plot to: {save_dir}/roc_curves.png")
    plt.close()


def main():
    print("=" * 60)
    print("      EEG CLASSIFIER EVALUATION PLOT GENERATOR")
    print("=" * 60)

    # Create save directory
    save_dir = pathlib.Path(__file__).resolve().parents[1] / "plots" / "evaluation"
    save_dir.mkdir(parents=True, exist_ok=True)

    # 1. Load metrics log
    try:
        metrics_log = load_metrics_log()
    except Exception as e:
        print(f"Error loading metrics log: {e}")
        sys.exit(1)

    # 2. Load dataset features for verification and ROC plots
    X_feats, y_bin, y_three, subject_ids = load_features()

    # 3. Generate figures
    plot_confusion_matrices(metrics_log, y_bin, y_three, save_dir)
    plot_model_comparison(metrics_log, save_dir)
    plot_feature_importance(save_dir)
    plot_roc_curves(X_feats, y_bin, subject_ids, save_dir)

    print("\n" + "=" * 60)
    print("       EVALUATION PLOTS GENERATED SUCCESSFULLY")
    print("=" * 60)


if __name__ == "__main__":
    main()
