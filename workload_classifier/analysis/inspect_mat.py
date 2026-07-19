import os
import scipy.io as sio
import numpy as np

def summarize_mat(file_path: str):
    print(f"\n=== Loading {os.path.basename(file_path)} ===")
    mat = sio.loadmat(file_path)
    for key, value in mat.items():
        if key.startswith("__"):
            continue
        if isinstance(value, np.ndarray):
            print(f"{key}: shape={value.shape}, dtype={value.dtype}")
        else:
            print(f"{key}: type={type(value)}")
    return mat

base_dir = os.path.abspath(os.path.join(__file__, "..", "..", "data", "stew"))
files = ["dataset.mat", "rating.mat", "class_012.mat", "three_class_one_hot.mat"]
for f in files:
    path = os.path.join(base_dir, f)
    summarize_mat(path)
