import time
import midas.client
from utils.qc_mapping import QC_Mapping
from utils.qc_grading import QC_Grading
from utils.qc_chip_handler import QC_ChipHandler
from utils.qc_power import PowerControl


# -----------------------------------------------------------------------------
# Injection scan sequence
# -----------------------------------------------------------------------------
# Registers the injection configuration, constructs the required
# hardware-control interfaces and executes one full injection measurement.
def define_params(seq):
    mapping = QC_Mapping(seq)
    seq.register_param("MinColumns",            "Min column",                   0)
    seq.register_param("MaxColumns",            "Max column",                   255)
    seq.register_param("MinRows",               "Min row",                      0)
    seq.register_param("MaxRows",               "Max row",                      249)
    seq.register_param("PulseNumber",           "Number of injection pulses",   10)
    seq.register_param("injectionWaitTime",     "Wait time per pulse (ms)",     1)
    seq.register_param("Injection_pulse",       "Injection pulse length ",      1008)
    seq.register_param("ThHigh",                "Threshold High",               130)
    seq.register_param("ThLow",                 "Threshold Low",                129)
    seq.register_param("VCAL",                  "Calibration voltage",          255)
    seq.register_param("lv_voltage",            "LV (V)",                       mapping.global_lv_voltage)
    seq.register_param("hv_voltage",            "HV (V)",                       mapping.global_hv_voltage_noise_scan)
    seq.register_param("hv_current_limit",      "HV limit",                     mapping.global_hv_current_limit)
    seq.register_param("runstart_working",      "Runstart working",             True)


# -----------------------------------------------------------------------------
# Main sequence execution
# -----------------------------------------------------------------------------
# Creates the mapping, chip-control, power-control and grading interfaces, then
# runs the injection routine using the registered standalone-scan parameters.
def sequence(seq):
    """Main sequence execution"""
    try:
        mapping = QC_Mapping(seq)  # Use sequencer's MIDAS client
        chip_handler = QC_ChipHandler(seq, mapping)  # Use sequencer's MIDAS client
        power = PowerControl(seq, mapping) # Use sequencer's MIDAS client
        grading = QC_Grading(seq, mapping)  # Use sequencer's MIDAS client
        from routines.qcRoutine_injection import Injection
        injection = Injection(seq, mapping, chip_handler, power, full_qc=False, QC_Grading=grading)
        injection.start()

    except Exception as e:
        seq.msg(f"Error during Injection: {str(e)}")
        raise


# -----------------------------------------------------------------------------
# Sequence cleanup
# -----------------------------------------------------------------------------
# Releases the injection command before stopping the active run when the
# sequence exits.
def at_exit(seq):
    """Cleanup function called when sequence exits"""
    # Injection locks switch_fe and makes it block the transition to end run, so we
    # need to turn it off before stopping the run.
    base = "/Equipment/PixelsCentral/Commands/MupixInjection"
    seq.odb_set(f"{base}/Full chip Injection", False)
    seq.stop_run()


if __name__ == "__main__":

    start_timer = time.time()
    client = midas.client.MidasClient("injectionClient")
    print("Time taken: ", time.time()-start_timer)
