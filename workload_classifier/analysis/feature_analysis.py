# feature_analysis.py
"""Statistical analysis and validation script for EEG features.

Performs ANOVA F-tests to rank features by discriminative power, generates
boxplots of the top features across workload classes to evaluate separability,
plots correlation matrices, and validates structural integrity of the output datasets.
"""

import os
import sys
import pathlib
import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
import seaborn as sns
from sklearn.feature_selection import f_classif

# Ensure parent directory is in sys.path for local module imports
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

from workload_classifier.extractor import load_features

# Standard 14 channels of Emotiv EPOC
CHANNELS = ["AF3", "F7", "F3", "FC5", "T7", "P7", "O1", "O2", "P8", "T8", "FC6", "F4", "F8", "AF4"]

# Feature types extracted per channel
FEATURE_TYPES = [
    "abs_theta", "abs_alpha", "abs_beta",
    "rel_theta", "rel_alpha", "rel_beta",
    "de_theta", "de_alpha", "de_beta",
    "hjorth_activity", "hjorth_mobility", "hjorth_complexity",
    "spectral_entropy"
]


def generate_feature_names() -> list:
    """Generate descriptive names for all 182 extracted features."""
    names = []
    for ch in CHANNELS:
        for f_type in FEATURE_TYPES:
            names.append(f"{ch}_{f_type}")
    return names


def main():
    print("=" * 60)
    print("        EEG FEATURE EXTRACTION AND STATISTICAL ANALYSIS")
    print("=" * 60)

    # 1. Run the feature extraction pipeline
    print("Step 1: Running feature extraction pipeline...")
    try:
        X_feats, y_bin, y_three, subject_ids = load_features(force_recompute=True)
    except Exception as e:
        print(f"Error extracting features: {e}")
        sys.exit(1)

    print(f"Features extracted successfully.")
    print(f"  - Feature matrix X shape: {X_feats.shape} (N_Samples, N_Features)")
    print(f"  - Labels y_binary shape: {y_bin.shape}")
    print(f"  - Labels y_three shape : {y_three.shape}")
    print(f"  - Subject mapping shape: {subject_ids.shape}")

    # Generate feature names
    feature_names = generate_feature_names()
    assert len(feature_names) == X_feats.shape[1], \
        f"Feature count mismatch: Expected {len(feature_names)}, got {X_feats.shape[1]}"

    # Create a DataFrame for analysis
    df = pd.DataFrame(X_feats, columns=feature_names)
    df["workload_class"] = y_three
    df["binary_class"] = y_bin

    # 2. Check for NaNs/Infs
    print("\nStep 2: Performing numerical checks...")
    num_nans = np.isnan(X_feats).sum()
    num_infs = np.isinf(X_feats).sum()
    print(f"  - Total NaN values found: {num_nans}")
    print(f"  - Total Inf values found: {num_infs}")
    assert num_nans == 0, "Numerical Check Failed: NaN values present!"
    assert num_infs == 0, "Numerical Check Failed: Inf values present!"
    print("  [PASSED] Feature matrix is numerically clean.")

    # 3. Perform ANOVA F-Test for Feature Selection
    print("\nStep 3: Calculating ANOVA F-values across three workload classes...")
    # Calculate F-values and p-values
    f_vals, p_vals = f_classif(X_feats, y_three)
    
    # Create ANOVA summary DataFrame
    anova_df = pd.DataFrame({
        "Feature": feature_names,
        "F-Value": f_vals,
        "p-Value": p_vals
    }).sort_values(by="F-Value", ascending=False).reset_index(drop=True)

    print("\nTop 10 Most Discriminative Features (ANOVA F-Test):")
    print(anova_df.head(10).to_string(index=False))

    # Save ANOVA summary to file
    out_dir = pathlib.Path(__file__).resolve().parents[1] / "data" / "stew"
    anova_df.to_csv(out_dir / "anova_feature_ranking.csv", index=False)
    print(f"ANOVA feature ranking saved to: {out_dir}/anova_feature_ranking.csv")

    # 4. Generate visualisations
    print("\nStep 4: Generating visualisations for top discriminative features...")
    plot_dir = pathlib.Path(__file__).resolve().parents[1] / "plots" / "features"
    plot_dir.mkdir(parents=True, exist_ok=True)

    # Set style
    sns.set_theme(style="whitegrid", context="talk", palette="muted")
    plt.rcParams.update({
        "font.family": "sans-serif",
        "font.sans-serif": ["Inter", "Roboto", "Helvetica", "Arial"],
    })

    # Plot Boxplots for the Top 6 Features
    top_features = anova_df.head(6)["Feature"].tolist()
    
    # Map class integers to string labels for clarity
    class_map = {0: "Normal", 1: "Moderate", 2: "High"}
    plot_df = df[top_features + ["workload_class"]].copy()
    plot_df["Workload Level"] = plot_df["workload_class"].map(class_map)
    
    # Create a grid of boxplots
    fig, axes = plt.subplots(2, 3, figsize=(18, 11))
    axes = axes.flatten()

    for idx, feat in enumerate(top_features):
        ax = axes[idx]
        sns.boxplot(
            x="Workload Level",
            y=feat,
            data=plot_df,
            ax=ax,
            palette="viridis",
            order=["Normal", "Moderate", "High"]
        )
        ax.set_title(f"{feat}\n(F-value: {anova_df.loc[idx, 'F-Value']:.2f})", weight="bold")
        ax.set_xlabel("")
        ax.set_ylabel("Feature Value")
        ax.grid(True, linestyle="--", alpha=0.5)

    plt.suptitle("Feature Distribution across Workload Classes (Top 6 Features)", weight="bold", y=0.98)
    plt.tight_layout()
    box_plot_path = plot_dir / "top_features_boxplots.png"
    plt.savefig(box_plot_path, dpi=300, bbox_inches="tight")
    print(f"Saved boxplots of top features to: {box_plot_path}")
    plt.close()

    # Plot Correlation Matrix Heatmap of Top 10 features to inspect redundancy
    top_10_features = anova_df.head(10)["Feature"].tolist()
    corr_matrix = df[top_10_features].corr()
    
    plt.figure(figsize=(11, 9))
    sns.heatmap(
        corr_matrix,
        annot=True,
        cmap="coolwarm",
        fmt=".2f",
        linewidths=0.5,
        vmin=-1,
        vmax=1
    )
    plt.title("Correlation Matrix of Top 10 Features", weight="bold", pad=15)
    plt.tight_layout()
    corr_plot_path = plot_dir / "top_features_correlation.png"
    plt.savefig(corr_plot_path, dpi=300, bbox_inches="tight")
    print(f"Saved correlation heatmap to: {corr_plot_path}")
    plt.close()

    print("\n" + "=" * 60)
    print("     FEATURE EXTRACTION & ANALYSIS COMPLETED SUCCESSFULLY")
    print("=" * 60)


if __name__ == "__main__":
    main()
