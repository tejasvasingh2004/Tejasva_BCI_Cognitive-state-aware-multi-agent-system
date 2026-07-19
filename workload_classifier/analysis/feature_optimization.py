# feature_optimization.py
"""Feature optimization study for EEG-based cognitive workload estimation.

Compares No Feature Selection, ANOVA Top-K, Recursive Feature Elimination (RFE),
PCA, and Random Forest Gini Importance under strict cross-subject GroupKFold validation.
Identifies the minimal feature subset that maintains high classification accuracy
and generates diagnostic plots.
"""

import sys
import pathlib
import time
import json
import joblib
import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
import seaborn as sns

from sklearn.model_selection import GroupKFold
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import Pipeline
from sklearn.metrics import (
    accuracy_score,
    balanced_accuracy_score,
    f1_score,
    roc_auc_score
)
from sklearn.linear_model import LogisticRegression
from sklearn.ensemble import RandomForestClassifier
from sklearn.svm import SVC
from sklearn.feature_selection import f_classif, RFE
from sklearn.decomposition import PCA

# Ensure parent directory is in sys.path for local module imports
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

from workload_classifier.extractor import load_features
from workload_classifier.analysis.feature_analysis import generate_feature_names

def run_feature_optimization_study():
    print("=" * 70)
    # 1. Load data
    print("Step 1: Loading features and subject mappings...")
    X, y, _, subject_ids = load_features()
    feature_names = np.array(generate_feature_names())
    
    print(f"Loaded feature matrix: shape {X.shape} (N_Samples, N_Features)")
    
    # 2. Setup Validation
    gkf = GroupKFold(n_splits=5)
    
    # Base classifier: SVM RBF (best model from Phase 4)
    clf = SVC(kernel="rbf", C=1.0, gamma=0.1, probability=True, random_state=42)
    
    # Define K range to test
    K_values = [5, 10, 20, 30, 50, 75, 100, 125, 150, 182]
    methods = ["ANOVA", "PCA", "RF_Importance", "RFE"]
    
    # Structure to hold all cross-validation results
    # { method: { K: { "accuracy": [], "balanced_acc": [], "f1": [], "auc": [], "train_time": [], "inf_time": [] } } }
    results = {m: {k: {"accuracy": [], "balanced_acc": [], "f1": [], "auc": [], "train_time": [], "inf_time": []} for k in K_values} for m in methods}
    
    # Baseline: No Feature Selection (182 features)
    baseline_results = {"accuracy": [], "balanced_acc": [], "f1": [], "auc": [], "train_time": [], "inf_time": []}
    
    print("\nStep 2: Evaluating No Feature Selection baseline (182 features)...")
    for fold, (train_idx, test_idx) in enumerate(gkf.split(X, y, groups=subject_ids)):
        X_train, X_test = X[train_idx], X[test_idx]
        y_train, y_test = y[train_idx], y[test_idx]
        
        # Standardize and Fit
        t0 = time.perf_counter()
        scaler = StandardScaler()
        X_train_scaled = scaler.fit_transform(X_train)
        clf.fit(X_train_scaled, y_train)
        t_train = time.perf_counter() - t0
        
        # Inference
        t1 = time.perf_counter()
        X_test_scaled = scaler.transform(X_test)
        preds = clf.predict(X_test_scaled)
        probs = clf.predict_proba(X_test_scaled)[:, 1]
        t_inf = (time.perf_counter() - t1) / len(test_idx) # time per sample
        
        baseline_results["accuracy"].append(accuracy_score(y_test, preds))
        baseline_results["balanced_acc"].append(balanced_accuracy_score(y_test, preds))
        baseline_results["f1"].append(f1_score(y_test, preds, average="macro"))
        baseline_results["auc"].append(roc_auc_score(y_test, probs))
        baseline_results["train_time"].append(t_train)
        baseline_results["inf_time"].append(t_inf * 1000.0) # convert to milliseconds
        
    print(f"  Baseline Macro F1: {np.mean(baseline_results['f1']):.4f} | Accuracy: {np.mean(baseline_results['accuracy']):.4f}")
    
    # Evaluate methods
    for method in methods:
        print(f"\nEvaluating Feature Selection Method: {method} ...")
        for K in K_values:
            # Skip K=182 for selection methods, it's equivalent to baseline
            if K == 182:
                for metric in results[method][K]:
                    results[method][K][metric] = baseline_results[metric]
                continue
                
            print(f"  Testing K = {K} ...")
            
            for fold, (train_idx, test_idx) in enumerate(gkf.split(X, y, groups=subject_ids)):
                X_train, X_test = X[train_idx], X[test_idx]
                y_train, y_test = y[train_idx], y[test_idx]
                
                t0 = time.perf_counter()
                
                # --- Feature Selection Logic (Strictly on Training split) ---
                if method == "ANOVA":
                    f_vals, _ = f_classif(X_train, y_train)
                    selected_idx = np.argsort(f_vals)[::-1][:K]
                    X_train_sel = X_train[:, selected_idx]
                    X_test_sel = X_test[:, selected_idx]
                    
                elif method == "PCA":
                    # Standardize first before PCA
                    scaler_pca = StandardScaler()
                    X_train_pca_scaled = scaler_pca.fit_transform(X_train)
                    pca = PCA(n_components=K, random_state=42)
                    X_train_sel = pca.fit_transform(X_train_pca_scaled)
                    X_test_sel = pca.transform(scaler_pca.transform(X_test))
                    
                elif method == "RF_Importance":
                    rf = RandomForestClassifier(n_estimators=50, max_depth=5, random_state=42, n_jobs=-1)
                    rf.fit(X_train, y_train)
                    importances = rf.feature_importances_
                    selected_idx = np.argsort(importances)[::-1][:K]
                    X_train_sel = X_train[:, selected_idx]
                    X_test_sel = X_test[:, selected_idx]
                    
                elif method == "RFE":
                    # RFE using LogisticRegression (faster than RF for RFE)
                    rfe_estimator = LogisticRegression(max_iter=1000, class_weight="balanced", random_state=42)
                    # Step=10 to speed up RFE execution
                    rfe = RFE(estimator=rfe_estimator, n_features_to_select=K, step=10)
                    X_train_sel = rfe.fit_transform(X_train, y_train)
                    X_test_sel = rfe.transform(X_test)
                
                # Standardize and Fit Classifier
                if method != "PCA": # PCA inputs are already standardized
                    scaler = StandardScaler()
                    X_train_sel_scaled = scaler.fit_transform(X_train_sel)
                    X_test_sel_scaled = scaler.transform(X_test_sel)
                else:
                    X_train_sel_scaled = X_train_sel
                    X_test_sel_scaled = X_test_sel
                    
                clf.fit(X_train_sel_scaled, y_train)
                t_train = time.perf_counter() - t0
                
                # Inference
                t1 = time.perf_counter()
                preds = clf.predict(X_test_sel_scaled)
                probs = clf.predict_proba(X_test_sel_scaled)[:, 1]
                t_inf = (time.perf_counter() - t1) / len(test_idx)
                
                # Log metrics
                results[method][K]["accuracy"].append(accuracy_score(y_test, preds))
                results[method][K]["balanced_acc"].append(balanced_accuracy_score(y_test, preds))
                results[method][K]["f1"].append(f1_score(y_test, preds, average="macro"))
                results[method][K]["auc"].append(roc_auc_score(y_test, probs))
                results[method][K]["train_time"].append(t_train)
                results[method][K]["inf_time"].append(t_inf * 1000.0) # milliseconds
                
            print(f"    Macro F1: {np.mean(results[method][K]['f1']):.4f} | Accuracy: {np.mean(results[method][K]['accuracy']):.4f}")
            
    # 3. Create Summary Tables
    # Compare methods at optimal K (e.g. K=30 features)
    summary_data = []
    
    # Baseline
    summary_data.append({
        "Method": "No Selection",
        "K_Features": 182,
        "Accuracy": np.mean(baseline_results["accuracy"]),
        "Balanced Acc": np.mean(baseline_results["balanced_acc"]),
        "Macro F1": np.mean(baseline_results["f1"]),
        "ROC-AUC": np.mean(baseline_results["auc"]),
        "Train Time (s)": np.mean(baseline_results["train_time"]),
        "Inference Time/Sample (ms)": np.mean(baseline_results["inf_time"])
    })
    
    for method in methods:
        for K in K_values[:-1]:
            summary_data.append({
                "Method": method,
                "K_Features": K,
                "Accuracy": np.mean(results[method][K]["accuracy"]),
                "Balanced Acc": np.mean(results[method][K]["balanced_acc"]),
                "Macro F1": np.mean(results[method][K]["f1"]),
                "ROC-AUC": np.mean(results[method][K]["auc"]),
                "Train Time (s)": np.mean(results[method][K]["train_time"]),
                "Inference Time/Sample (ms)": np.mean(results[method][K]["inf_time"])
            })
            
    df_results = pd.DataFrame(summary_data)
    
    # Determine smallest optimal feature representation
    # Select K that achieves Macro F1 >= baseline - 0.02
    baseline_f1 = np.mean(baseline_results["f1"])
    candidate_runs = df_results[df_results["Macro F1"] >= (baseline_f1 - 0.02)]
    
    if len(candidate_runs) > 0:
        optimal_run = candidate_runs.sort_values(by=["K_Features", "Macro F1"], ascending=[True, False]).iloc[0]
    else:
        optimal_run = df_results.sort_values(by="Macro F1", ascending=False).iloc[0]
        
    optimal_method = optimal_run["Method"]
    optimal_k = int(optimal_run["K_Features"])
    
    print("\n" + "=" * 60)
    print("      FEATURE OPTIMIZATION PERFORMANCE COMPARISON")
    print("=" * 60)
    print(df_results.sort_values(by="Macro F1", ascending=False).head(15).to_string(index=False))
    print("\n" + "=" * 60)
    print(f"Optimal Configuration Recommended for FastAPI Deployment:")
    print(f"  Method: {optimal_method}")
    print(f"  Selected Features Count (K): {optimal_k}")
    print(f"  Expected Macro F1 Score    : {optimal_run['Macro F1']:.4f}")
    print(f"  Expected Accuracy          : {optimal_run['Accuracy']:.4f}")
    print(f"  Expected Inference Time    : {optimal_run['Inference Time/Sample (ms)']:.4f} ms/sample")
    print("=" * 60)
    
    # Save optimal indices
    if optimal_method == "ANOVA":
        f_vals, _ = f_classif(X, y)
        selected_idx = np.argsort(f_vals)[::-1][:optimal_k]
    elif optimal_method == "RF_Importance":
        rf = RandomForestClassifier(n_estimators=100, max_depth=10, random_state=42)
        rf.fit(X, y)
        selected_idx = np.argsort(rf.feature_importances_)[::-1][:optimal_k]
    elif optimal_method == "RFE":
        rfe_estimator = LogisticRegression(max_iter=1000, class_weight="balanced", random_state=42)
        rfe = RFE(estimator=rfe_estimator, n_features_to_select=optimal_k, step=10)
        rfe.fit(X, y)
        selected_idx = np.where(rfe.support_)[0]
    else: # PCA
        selected_idx = list(range(optimal_k))
        
    selected_features_list = feature_names[selected_idx].tolist() if optimal_method != "PCA" else [f"PC_{i+1}" for i in range(optimal_k)]
    
    # Save metadata
    data_dir = pathlib.Path(__file__).resolve().parents[1] / "data" / "stew"
    data_dir.mkdir(parents=True, exist_ok=True)
    
    meta_path = data_dir / "selected_features.json"
    with open(meta_path, "w") as f:
        json.dump({
            "method": optimal_method,
            "k_features": optimal_k,
            "selected_indices": [int(idx) for idx in selected_idx] if optimal_method != "PCA" else [],
            "selected_names": selected_features_list,
            "accuracy": float(optimal_run["Accuracy"]),
            "macro_f1": float(optimal_run["Macro F1"]),
            "inference_time_ms": float(optimal_run["Inference Time/Sample (ms)"])
        }, f, indent=4)
    print(f"Saved selected features manifest to: {meta_path}")
    
    # Save optimized model fitted on the entire dataset using the selected features
    if optimal_method == "PCA":
        scaler_pca = StandardScaler()
        X_scaled = scaler_pca.fit_transform(X)
        pca = PCA(n_components=optimal_k, random_state=42)
        X_opt = pca.fit_transform(X_scaled)
        final_clf = SVC(kernel="rbf", C=1.0, gamma=0.1, probability=True, random_state=42)
        final_clf.fit(X_opt, y)
        optimized_pipe = Pipeline([
            ("scaler", scaler_pca),
            ("pca", pca),
            ("classifier", final_clf)
        ])
    else:
        X_opt = X[:, selected_idx]
        scaler = StandardScaler()
        X_opt_scaled = scaler.fit_transform(X_opt)
        final_clf = SVC(kernel="rbf", C=1.0, gamma=0.1, probability=True, random_state=42)
        final_clf.fit(X_opt_scaled, y)
        optimized_pipe = Pipeline([
            ("scaler", scaler),
            ("classifier", final_clf)
        ])
        
    model_path = data_dir / "best_model_optimized.joblib"
    joblib.dump(optimized_pipe, model_path)
    print(f"Saved optimized final pipeline to: {model_path}")
    
    # Save results dictionary to JSON
    with open(data_dir / "optimization_results.json", "w") as f:
        # Convert list structures to standard floats for json compatibility
        cleaned_results = {
            "baseline": {k: float(np.mean(v)) for k, v in baseline_results.items()},
            "methods": {
                m: {
                    str(k): {metric: float(np.mean(v)) for metric, v in results[m][k].items()}
                    for k in K_values
                } for m in methods
            }
        }
        json.dump(cleaned_results, f, indent=4)
    print(f"Saved optimization logs to: {data_dir / 'optimization_results.json'}")
    
    # 4. Generate Diagnostic Plots
    plot_dir = pathlib.Path(__file__).resolve().parents[1] / "plots" / "optimization"
    plot_dir.mkdir(parents=True, exist_ok=True)
    
    sns.set_theme(style="whitegrid", context="talk")
    plt.rcParams.update({
        "font.family": "sans-serif",
        "font.sans-serif": ["Inter", "Roboto", "Helvetica", "Arial"],
    })
    
    # Plot 1: Feature Importance Ranking (Top 20 Features via ANOVA F-value)
    f_vals_all, _ = f_classif(X, y)
    anova_all_df = pd.DataFrame({
        "Feature": feature_names,
        "F-Value": f_vals_all
    }).sort_values(by="F-Value", ascending=False).reset_index(drop=True)
    
    plt.figure(figsize=(12, 8))
    sns.barplot(
        x="F-Value",
        y="Feature",
        data=anova_all_df.head(20),
        palette="viridis"
    )
    plt.title("Top 20 Features Ranked by ANOVA F-value (Entire Dataset)", weight="bold", pad=15)
    plt.xlabel("ANOVA F-value (Separability)")
    plt.ylabel("")
    plt.tight_layout()
    plot1_path = plot_dir / "feature_importance_ranking.png"
    plt.savefig(plot1_path, dpi=300, bbox_inches="tight")
    print(f"Saved Plot 1 to: {plot1_path}")
    plt.close()
    
    # Plot 2: Accuracy vs. Number of Features (Macro F1 Comparison)
    plt.figure(figsize=(12, 8))
    # Baseline
    plt.axhline(
        y=np.mean(baseline_results["f1"]),
        color="red",
        linestyle="--",
        label=f"Baseline (182 Features, F1={np.mean(baseline_results['f1']):.4f})"
    )
    
    # Plot curves for each method
    for method in methods:
        f1_scores = [np.mean(results[method][K]["f1"]) for K in K_values]
        plt.plot(K_values, f1_scores, marker="o", label=f"{method}")
        
    plt.title("Classification Performance vs. Feature Subset Size", weight="bold", pad=15)
    plt.xlabel("Number of Features (K)")
    plt.ylabel("Macro-F1 Score")
    plt.legend(loc="lower right")
    plt.grid(True, linestyle="--", alpha=0.5)
    plt.tight_layout()
    plot2_path = plot_dir / "performance_vs_feature_count.png"
    plt.savefig(plot2_path, dpi=300, bbox_inches="tight")
    print(f"Saved Plot 2 to: {plot2_path}")
    plt.close()
    
    # Plot 3: PCA Explained Variance
    scaler_full = StandardScaler()
    X_scaled = scaler_full.fit_transform(X)
    pca_full = PCA(random_state=42)
    pca_full.fit(X_scaled)
    cum_var = np.cumsum(pca_full.explained_variance_ratio_)
    
    plt.figure(figsize=(12, 8))
    plt.plot(range(1, len(cum_var)+1), cum_var, color="blue", linewidth=2.5)
    # Highlight threshold markers
    for th in [0.90, 0.95, 0.99]:
        idx_th = np.where(cum_var >= th)[0][0]
        plt.axhline(y=th, color="gray", linestyle=":", alpha=0.7)
        plt.axvline(x=idx_th+1, color="gray", linestyle=":", alpha=0.7)
        plt.plot(idx_th+1, th, "ro")
        plt.text(idx_th+4, th-0.03, f"{th*100:.0f}% ({idx_th+1} PCs)", color="darkred", fontsize=12)
        
    plt.title("PCA Cumulative Explained Variance Ratio", weight="bold", pad=15)
    plt.xlabel("Principal Components")
    plt.ylabel("Explained Variance Ratio")
    plt.xlim(0, 185)
    plt.ylim(0.2, 1.05)
    plt.grid(True, linestyle="--", alpha=0.5)
    plt.tight_layout()
    plot3_path = plot_dir / "pca_explained_variance.png"
    plt.savefig(plot3_path, dpi=300, bbox_inches="tight")
    print(f"Saved Plot 3 to: {plot3_path}")
    plt.close()

if __name__ == "__main__":
    run_feature_optimization_study()
