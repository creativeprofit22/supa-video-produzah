//! Parity metrics between two beat lists (reference vs candidate), used by the parity tests and
//! the benchmark.
//!
//! F-measure follows mir_eval's beat F-measure (±70 ms window, one-to-one matching), without
//! mir_eval's default trimming of the first five seconds: parity must hold everywhere.

/// mir_eval's default beat F-measure window.
pub const F_MEASURE_WINDOW_S: f64 = 0.070;

/// Pass criteria from the plan (per track, beats and downbeats separately).
pub const MAX_DEVIATION_S: f64 = 0.020;
pub const CLOSE_DEVIATION_S: f64 = 0.001;
pub const MIN_CLOSE_FRACTION: f64 = 0.995;

#[derive(Debug, Clone, PartialEq)]
pub struct Comparison {
    pub reference_count: usize,
    pub candidate_count: usize,
    pub matched: usize,
    pub f_measure: f64,
    /// Fraction of matched pairs within [`CLOSE_DEVIATION_S`] (1.0 when nothing is matched).
    pub close_fraction: f64,
    /// Largest |reference - candidate| over matched pairs.
    pub max_deviation_s: f64,
}

impl Comparison {
    /// Whether this comparison meets every pass criterion.
    pub fn passes(&self) -> bool {
        self.reference_count == self.candidate_count
            && self.f_measure == 1.0
            && self.close_fraction >= MIN_CLOSE_FRACTION
            && self.max_deviation_s <= MAX_DEVIATION_S
    }

    /// Human-readable failure reasons (empty when it passes).
    pub fn failures(&self) -> Vec<String> {
        let mut failures = Vec::new();
        if self.reference_count != self.candidate_count {
            failures.push(format!(
                "count {} vs reference {}",
                self.candidate_count, self.reference_count
            ));
        }
        if self.f_measure != 1.0 {
            failures.push(format!("F-measure {:.6} < 1", self.f_measure));
        }
        if self.close_fraction < MIN_CLOSE_FRACTION {
            failures.push(format!(
                "{:.3}% within 1 ms < {:.1}%",
                self.close_fraction * 100.0,
                MIN_CLOSE_FRACTION * 100.0
            ));
        }
        if self.max_deviation_s > MAX_DEVIATION_S {
            failures.push(format!(
                "max deviation {:.3} ms > {:.0} ms",
                self.max_deviation_s * 1000.0,
                MAX_DEVIATION_S * 1000.0
            ));
        }
        failures
    }
}

/// Compares sorted beat times (seconds).
///
/// Matching is one-to-one within `window_s`. On a line with a symmetric window, a two-pointer
/// sweep that pairs the earliest unmatched reference with the earliest candidate in range yields
/// a maximum matching, which is what mir_eval's bipartite matching computes.
pub fn compare(reference: &[f64], candidate: &[f64], window_s: f64) -> Comparison {
    let mut deviations = Vec::new();
    let (mut r, mut c) = (0, 0);
    while r < reference.len() && c < candidate.len() {
        let difference = candidate[c] - reference[r];
        if difference.abs() <= window_s {
            deviations.push(difference.abs());
            r += 1;
            c += 1;
        } else if difference < 0.0 {
            c += 1;
        } else {
            r += 1;
        }
    }
    let matched = deviations.len();
    let f_measure = if reference.is_empty() && candidate.is_empty() {
        1.0
    } else if matched == 0 {
        0.0
    } else {
        let precision = matched as f64 / candidate.len() as f64;
        let recall = matched as f64 / reference.len() as f64;
        2.0 * precision * recall / (precision + recall)
    };
    let close = deviations
        .iter()
        .filter(|&&deviation| deviation <= CLOSE_DEVIATION_S)
        .count();
    Comparison {
        reference_count: reference.len(),
        candidate_count: candidate.len(),
        matched,
        f_measure,
        close_fraction: if matched == 0 {
            1.0
        } else {
            close as f64 / matched as f64
        },
        max_deviation_s: deviations.into_iter().fold(0.0, f64::max),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identical_lists_pass() {
        let beats = [0.5, 1.0, 1.5, 2.0];

        let comparison = compare(&beats, &beats, F_MEASURE_WINDOW_S);

        assert_eq!(comparison.f_measure, 1.0);
        assert_eq!(comparison.max_deviation_s, 0.0);
        assert!(comparison.passes(), "{:?}", comparison.failures());
    }

    #[test]
    fn empty_lists_agree() {
        assert!(compare(&[], &[], F_MEASURE_WINDOW_S).passes());
        assert_eq!(compare(&[1.0], &[], F_MEASURE_WINDOW_S).f_measure, 0.0);
    }

    #[test]
    fn f_measure_matches_mir_eval_for_a_missed_and_an_extra_beat() {
        // reference has 4 beats; candidate misses 1.5 and adds 2.3 → 3 matches of 4 and 4.
        let reference = [0.5, 1.0, 1.5, 2.0];
        let candidate = [0.52, 1.0, 2.0, 2.3];

        let comparison = compare(&reference, &candidate, F_MEASURE_WINDOW_S);

        assert_eq!(comparison.matched, 3);
        assert!((comparison.f_measure - 0.75).abs() < 1e-12);
        assert!(!comparison.passes());
    }

    #[test]
    fn window_edges_are_inclusive_and_one_to_one() {
        let comparison = compare(&[1.0], &[0.95, 1.05], F_MEASURE_WINDOW_S);

        assert_eq!(comparison.matched, 1);
        assert_eq!(comparison.candidate_count, 2);
    }

    #[test]
    fn rare_sub_frame_shifts_pass_but_frequent_ones_fail_the_1ms_share() {
        let reference: Vec<f64> = (0..400).map(|index| f64::from(index) * 0.5).collect();
        let mut candidate = reference.clone();
        candidate[10] += 0.019;
        let mut drifted = reference.clone();
        for value in drifted.iter_mut().take(10) {
            *value += 0.019;
        }

        let one_frame = compare(&reference, &candidate, F_MEASURE_WINDOW_S);
        let ten_frames = compare(&reference, &drifted, F_MEASURE_WINDOW_S);

        assert!(one_frame.passes(), "{:?}", one_frame.failures());
        assert!(!ten_frames.passes());
        assert_eq!(
            ten_frames.failures().len(),
            1,
            "{:?}",
            ten_frames.failures()
        );
    }

    #[test]
    fn deviation_over_one_frame_fails() {
        let comparison = compare(&[1.0], &[1.03], F_MEASURE_WINDOW_S);

        assert_eq!(comparison.f_measure, 1.0);
        assert!(!comparison.passes());
        assert!(comparison.failures()[0].contains("within 1 ms"));
    }
}
