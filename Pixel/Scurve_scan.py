import time
import midas.client
from utils.qc_mapping import QC_Mapping
from utils.qc_grading import QC_Grading
from utils.qc_chip_handler import QC_ChipHandler
from utils.qc_power import PowerControl
from routines.qcRoutine_noise_scan import NoiseScan
from routines.qcRoutine_Scurve_scan import Scurve_scan

# -----------------------------------------------------------------------------
# S-curve scan sequence
# -----------------------------------------------------------------------------
# Registers the scan configuration, constructs the required hardware-control
# interfaces and executes the S-curve parameter optimization routine.

def define_params(seq):
    mapping = QC_Mapping(seq)
    seq.register_param("noise_ThHigh_start",    "Start threshold value",        130)
    seq.register_param("noise_ThHigh_stop",     "Stop threshold value",         118)
    seq.register_param("max_iterations",        "Maximum iteration",            10)
    seq.register_param("MinColumns",            "Min column",                   0)
    seq.register_param("MaxColumns",            "Max column",                   50)
    seq.register_param("MinRows",               "Min row",                      0)
    seq.register_param("MaxRows",               "Max row",                      50)
    seq.register_param("PulseNumber",           "Number of injection pulses",   5)
    seq.register_param("injectionWaitTime",     "Wait time per pulse (ms)",     5)

    # -------------------------------------------------------------------------
    # S-curve parameter range
    # -------------------------------------------------------------------------
    # Defines the two-dimensional parameter grid traversed by Scurve_scan:
    #   ThHigh -> from ThHigh_min to ThHigh_max in ThHigh_step increments
    #   VCAL   -> from VCAL_min to VCAL_max in VCAL_step increments
    seq.register_param("ThHigh_max",            "Threshold max",                160)
    seq.register_param("ThHigh_min",            "Threshold min",                120)
    seq.register_param("ThHigh_step",           "Threshold step",               2)
    seq.register_param("VCAL_max",              "Calibration voltage max",      255)
    seq.register_param("VCAL_min",              "Calibration voltage min",      0)
    seq.register_param("VCAL_step",             "Calibration voltage step",     5)

    seq.register_param("noise_max_hits",        "Maximum hits for tuning",      3)
    seq.register_param("noise_run_time",        "Run time in seconds",          3)
    seq.register_param("noise_ThHigh_stepSize", "Step threshold value",         1)
    seq.register_param("max_errorrate_retries", "Max errorrate retries",        5)
    seq.register_param("max_link_errors",       "Maximum link errors",          500)
    seq.register_param("start_iterations",      "Start iteration",              0)
    seq.register_param("use_bypass",            "Using Bypass Mode",            True)
    seq.register_param("reset_histo",           "Reset Mask",                   1)
    seq.register_param("runstart_working",      "Runstart working",             True)
    seq.register_param("Injection_pulse",       "Injection pulse length ",      1008)
    seq.register_param("ThHigh",                "Threshold High",               121)
    seq.register_param("ThLow",                 "Threshold Low",                120)
    seq.register_param("VCAL",                  "Calibration voltage",          200)
    seq.register_param("lv_voltage",            "LV (V)",                       mapping.global_lv_voltage)
    seq.register_param("hv_voltage",            "HV (V)",                       mapping.global_hv_voltage_noise_scan)
    seq.register_param("hv_current_limit",      "HV limit",                     mapping.global_hv_current_limit)
    seq.register_param("runstart_working",      "Runstart working",             True)


# -----------------------------------------------------------------------------
# Main sequence execution
# -----------------------------------------------------------------------------
# Creates the mapping, chip-control, power-control and grading interfaces, then
# executes the S-curve scan over the registered threshold and VCAL ranges.
def sequence(seq):
    """Main sequence execution"""

    try:
        mapping = QC_Mapping(seq)  # Use sequencer's MIDAS client
        chip_handler = QC_ChipHandler(seq, mapping)  # Use sequencer's MIDAS client
        power = PowerControl(seq, mapping) # Use sequencer's MIDAS client
        grading = QC_Grading(seq, mapping)  # Use sequencer's MIDAS client
        noise_scan = NoiseScan(seq, chip_handler, mapping, power, full_qc=False, QC_Grading=grading)
        Scan = Scurve_scan(seq, mapping, chip_handler, power, full_qc=False, QC_Grading=grading)
        #noise_scan.start()
        Scan.start()

    except Exception as e:
        seq.msg(f"Error during Scurve_scan: {str(e)}")
        raise

# -----------------------------------------------------------------------------
# Sequence cleanup
# -----------------------------------------------------------------------------
# Stops any remaining sequencer activity and terminates the active run when
# the sequence exits.
#
# runstart_working controls how the run is stopped:
#   True  -> stop the run through the sequencer interface directly
#   False -> stop the run through the MSL script commands
def at_exit(seq):
    seq.odb_set("/Sequencer/Command/Stop immediately", True)
    runstart_working = seq.get_param("runstart_working")
    if not runstart_working:
        seq.odb_set("/Sequencer/State/Path", "pixels/msl_qc/generic_qc_files/")
        seq.odb_set("/Sequencer/Command/Load filename", "stop_run.msl")
        seq.odb_set("/Sequencer/State/Filename", "stop_run.msl")
        seq.odb_set("/Sequencer/Command/Load new file", True)
        seq.odb_set("/Sequencer/Command/Start script", True)
    else:
        seq.stop_run()

if __name__ == "__main__":

    start_timer = time.time()
    client = midas.client.MidasClient("injectionClient")
    print("Time taken: ", time.time()-start_timer)