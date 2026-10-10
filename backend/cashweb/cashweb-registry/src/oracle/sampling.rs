//! How one round's provider answers for one asset become a sample, and how samples are smoothed.
//!
//! Pure: no clock, no randomness, no I/O. The collector decides *whom* to ask; these functions
//! decide what the answers mean. Because [`judge`] depends only on the answers, the previous
//! smoothed point and configuration, the smoothed series can be recomputed from the stored
//! answers ([`replay`]).

use cashweb_config::OracleConf;

/// Tolerances and time constants, as fractions and seconds.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rules {
    /// Two answers within this fraction of the lower one agree.
    pub agree: f64,
    /// Two answers further apart than this fraction, with nobody else to ask, make no sample.
    pub wide: f64,
    /// A sample further than this fraction from the smoothed value needs a third answer.
    pub outlier: f64,
    /// Smoothing time constant, seconds.
    pub tau_s: f64,
    /// A smoothed value older than this is not continued.
    pub long_gap_s: u64,
}

impl From<&OracleConf> for Rules {
    fn from(conf: &OracleConf) -> Self {
        Rules {
            agree: f64::from(conf.agree_tolerance_bps) / 10_000.0,
            wide: f64::from(conf.two_source_max_spread_bps) / 10_000.0,
            outlier: f64::from(conf.outlier_threshold_bps) / 10_000.0,
            tau_s: conf.ewma_tau_s as f64,
            long_gap_s: conf.long_gap_s,
        }
    }
}

/// What a set of answers amounts to.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Verdict {
    /// The round's sample for the asset.
    Sample(f64),
    /// Another provider must answer before anything can be said.
    AskAnother,
    /// No sample this round.
    NoSample,
}

fn median(values: &[f64]) -> f64 {
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    let middle = sorted.len() / 2;
    if sorted.len() % 2 == 1 {
        sorted[middle]
    } else {
        (sorted[middle - 1] + sorted[middle]) / 2.0
    }
}

/// Judges the answers (each positive) gathered so far for one asset.
///
/// - `listed`: how many providers that list the asset can answer this round (configured,
///   keyed, not resting after a failure and not failed in this round).
/// - `can_ask`: whether one of them has not been asked yet.
/// - `previous`: the latest smoothed point `(time, value)`.
///
/// Rules: two answers that agree: their mean. Two that disagree: ask a third and take the
/// median of three; with nobody left to ask, their mean unless they are `wide` apart, then
/// nothing. A sample further than `outlier` from the smoothed value, or the first sample after
/// a long gap, also wants a third answer; with nobody left to ask, two that agree are taken.
/// One provider alone: its answer is the sample (single source), except that a lone answer
/// cannot confirm a jump: further than `outlier` from a recent smoothed value it is dropped.
pub fn judge(
    answers: &[f64],
    listed: usize,
    can_ask: bool,
    previous: Option<(u64, f64)>,
    now: u64,
    rules: &Rules,
) -> Verdict {
    let or_ask = |otherwise| {
        if can_ask {
            Verdict::AskAnother
        } else {
            otherwise
        }
    };
    let recent = previous.filter(|(time, _)| now.saturating_sub(*time) <= rules.long_gap_s);
    match answers {
        [] => or_ask(Verdict::NoSample),
        [only] if listed <= 1 => match recent {
            Some((_, smoothed)) if (only - smoothed).abs() / smoothed > rules.outlier => {
                Verdict::NoSample
            }
            _ => Verdict::Sample(*only),
        },
        [_] => or_ask(Verdict::NoSample),
        [a, b] => {
            let spread = (a - b).abs() / a.min(*b);
            if spread > rules.agree {
                if can_ask {
                    return Verdict::AskAnother;
                }
                if spread > rules.wide {
                    return Verdict::NoSample;
                }
            }
            let mean = (a + b) / 2.0;
            match recent {
                Some((_, smoothed)) if (mean - smoothed).abs() / smoothed <= rules.outlier => {
                    Verdict::Sample(mean)
                }
                Some(_) if listed > 2 => or_ask(Verdict::NoSample),
                _ => or_ask(Verdict::Sample(mean)),
            }
        }
        three_or_more => Verdict::Sample(median(three_or_more)),
    }
}

/// The smoothed value after `sample` arrives at `now`: a time-weighted exponential moving
/// average, `previous + alpha * (sample - previous)` with `alpha = 1 - exp(-dt / tau)`. With no
/// previous value, or one older than the long gap, the sample is the value.
pub fn smooth(previous: Option<(u64, f64)>, now: u64, sample: f64, rules: &Rules) -> f64 {
    match previous {
        Some((time, value)) if now.saturating_sub(time) <= rules.long_gap_s => {
            let dt = now.saturating_sub(time) as f64;
            let alpha = 1.0 - (-dt / rules.tau_s).exp();
            value + alpha * (sample - value)
        }
        _ => sample,
    }
}

/// Recomputes a smoothed series from stored answers: `rounds` is `(time, providers that could
/// be asked for the asset that round, answers)` oldest first, `previous` the smoothed point
/// before the first of them.
pub fn replay(
    rounds: &[(u64, usize, Vec<f64>)],
    mut previous: Option<(u64, f64)>,
    rules: &Rules,
) -> Vec<(u64, f64)> {
    let mut points = Vec::new();
    for (time, listed, answers) in rounds {
        if let Verdict::Sample(sample) = judge(answers, *listed, false, previous, *time, rules) {
            let value = smooth(previous, *time, sample, rules);
            previous = Some((*time, value));
            points.push((*time, value));
        }
    }
    points
}

#[cfg(test)]
mod tests {
    use super::*;

    const RULES: Rules = Rules {
        agree: 0.02,
        wide: 0.10,
        outlier: 0.10,
        tau_s: 1800.0,
        long_gap_s: 6 * 3600,
    };
    const NOW: u64 = 1_000_000;
    const RECENT: Option<(u64, f64)> = Some((NOW - 600, 100.0));

    #[test]
    fn two_that_agree_are_averaged_without_asking_anyone_else() {
        assert_eq!(
            judge(&[100.0, 101.0], 5, true, RECENT, NOW, &RULES),
            Verdict::Sample(100.5)
        );
    }

    #[test]
    fn two_that_disagree_ask_a_third_and_the_median_of_three_wins() {
        assert_eq!(
            judge(&[100.0, 104.0], 5, true, RECENT, NOW, &RULES),
            Verdict::AskAnother
        );
        // The third settles it, and one wild answer cannot move the result.
        assert_eq!(
            judge(&[100.0, 104.0, 100.4], 5, true, RECENT, NOW, &RULES),
            Verdict::Sample(100.4)
        );
        assert_eq!(
            judge(&[100.0, 9000.0, 100.4], 5, false, RECENT, NOW, &RULES),
            Verdict::Sample(100.4)
        );
    }

    #[test]
    fn exactly_two_far_apart_make_no_sample() {
        assert_eq!(
            judge(&[100.0, 120.0], 2, false, RECENT, NOW, &RULES),
            Verdict::NoSample
        );
        // Apart, but not widely: nobody can say which is right, the middle is within reach.
        assert_eq!(
            judge(&[100.0, 105.0], 2, false, RECENT, NOW, &RULES),
            Verdict::Sample(102.5)
        );
    }

    #[test]
    fn a_single_source_asset_uses_its_one_provider() {
        assert_eq!(
            judge(&[7.0], 1, false, Some((NOW - 600, 7.2)), NOW, &RULES),
            Verdict::Sample(7.0)
        );
        // Alone, it cannot confirm a jump; with nothing recent there is nothing to contradict.
        assert_eq!(
            judge(&[9.0], 1, false, Some((NOW - 600, 7.0)), NOW, &RULES),
            Verdict::NoSample
        );
        assert_eq!(
            judge(&[9.0], 1, false, Some((NOW - 7 * 3600, 7.0)), NOW, &RULES),
            Verdict::Sample(9.0)
        );
        // One answer while others that list the asset can still answer is not enough.
        assert_eq!(
            judge(&[7.0], 3, true, RECENT, NOW, &RULES),
            Verdict::AskAnother
        );
        assert_eq!(
            judge(&[7.0], 3, false, RECENT, NOW, &RULES),
            Verdict::NoSample
        );
    }

    #[test]
    fn a_jump_needs_a_third_provider_before_it_is_applied() {
        // Two providers agree with each other on a price 20% above the smoothed value.
        assert_eq!(
            judge(&[120.0, 121.0], 5, true, RECENT, NOW, &RULES),
            Verdict::AskAnother
        );
        // Confirmed: the median of three is applied.
        assert_eq!(
            judge(&[120.0, 121.0, 120.5], 5, false, RECENT, NOW, &RULES),
            Verdict::Sample(120.5)
        );
        // A third lists the asset and stayed silent about it: not applied this round.
        assert_eq!(
            judge(&[120.0, 121.0], 5, false, RECENT, NOW, &RULES),
            Verdict::NoSample
        );
        // Only two providers can answer: there is no third to wait for.
        assert_eq!(
            judge(&[120.0, 121.0], 2, false, RECENT, NOW, &RULES),
            Verdict::Sample(120.5)
        );
    }

    #[test]
    fn the_first_value_and_the_first_after_a_long_gap_want_three() {
        let stale = Some((NOW - 7 * 3600, 100.0));
        for previous in [None, stale] {
            assert_eq!(
                judge(&[250.0, 251.0], 5, true, previous, NOW, &RULES),
                Verdict::AskAnother
            );
            assert_eq!(
                judge(&[250.0, 251.0, 250.2], 5, true, previous, NOW, &RULES),
                Verdict::Sample(250.2)
            );
            // A stale value 60% away does not veto a fresh start.
            assert_eq!(
                judge(&[250.0, 251.0], 5, false, previous, NOW, &RULES),
                Verdict::Sample(250.5)
            );
            assert_eq!(smooth(previous, NOW, 250.2, &RULES), 250.2);
        }
    }

    #[test]
    fn smoothing_is_weighted_by_elapsed_time() {
        // One time constant later the value has moved 1 - 1/e of the way to the sample.
        let after_tau = smooth(Some((NOW - 1800, 100.0)), NOW, 110.0, &RULES);
        assert!((after_tau - (100.0 + 10.0 * (1.0 - (-1.0f64).exp()))).abs() < 1e-9);
        // Two samples ten minutes apart move it less than one sample twenty minutes later
        // would have: the weight follows the clock, not the number of samples.
        let ten = smooth(Some((NOW - 600, 100.0)), NOW, 110.0, &RULES);
        let twenty = smooth(Some((NOW - 1200, 100.0)), NOW, 110.0, &RULES);
        assert!(100.0 < ten && ten < twenty && twenty < after_tau);
        // Same sample at the same instant changes nothing.
        assert_eq!(smooth(Some((NOW, 100.0)), NOW, 110.0, &RULES), 100.0);
    }
}
