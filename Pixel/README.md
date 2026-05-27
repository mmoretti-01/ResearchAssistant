# Pixel Scripts

This folder contains scripts related to pixel-level studies and quality-control procedures.

## Injection Function

All scripts in this folder build upon the injection function defined in **`mupix_FEB.cpp`**. This function provides the basis for the measurements and studies implemented in the scripts contained here.

## Script Overview

The scripts whose filenames do **not** contain `qc` are primarily used as interfaces to the online database.

The scripts containing `qc` in their filenames implement most of the analysis and quality-control functionality. These scripts contain the core code for performing the corresponding measurements and studies.
