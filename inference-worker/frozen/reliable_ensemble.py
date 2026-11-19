"""Candidate calibrated continuous stacker. Written but not executed/tested.
Fit only on saved validation slide predictions. Never select using test labels.
"""
import argparse
import json
from pathlib import Path
import joblib
import numpy as np
from sklearn.base import clone
from sklearn.calibration import CalibratedClassifierCV
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score, brier_score_loss, log_loss, confusion_matrix
from sklearn.model_selection import StratifiedKFold
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

NAMES = ['efficientnet_b0', 'mobilevit_xxs', 'resnet50', 'spatial_graph_expert']
DEFAULT = Path(__file__).resolve().parent / 'runs' / '20261030_234916_956062'

def logits(x):
    x = np.asarray(x, dtype=float)
    if x.ndim != 2 or x.shape[1] != 4 or not np.isfinite(x).all() or ((x<0)|(x>1)).any():
        raise ValueError('Expected finite N x 4 slide probabilities in [0,1], in documented model order.')
    x = np.clip(x, 1e-6, 1-1e-6)
    return np.log(x)-np.log1p(-x)

def estimator():
    # Calibrate the entire continuous stacker, not binary votes.
    # Each inner calibrator sees slides excluded from its underlying stacker fit.
    stack = make_pipeline(StandardScaler(), LogisticRegression(C=.1, max_iter=2000, random_state=42))
    return CalibratedClassifierCV(estimator=stack, method='sigmoid',
        cv=StratifiedKFold(3, shuffle=True, random_state=43), ensemble=True)

def summarize(y, p, threshold):
    tn, fp, fn, tp = confusion_matrix(y, p >= threshold, labels=[0,1]).ravel()
    return dict(auroc=float(roc_auc_score(y,p)), brier=float(brier_score_loss(y,p)),
        log_loss=float(log_loss(y,p,labels=[0,1])), threshold=float(threshold),
        sensitivity=float(tp/(tp+fn)), specificity=float(tn/(tn+fp)),
        accuracy=float((tp+tn)/len(y)), F1=float(2*tp/(2*tp+fp+fn)) if tp else 0.,
        confusion_matrix=[[int(tn),int(fp)],[int(fn),int(tp)]])

def operating_threshold(y, p, target):
    # No arbitrary .10 floor. Include all distinct score decision boundaries.
    candidates = np.unique(np.r_[0., p, 1.])
    eligible = []
    for t in candidates:
        m = summarize(y,p,t)
        if m['sensitivity'] >= target:
            eligible.append(m)
    return max(eligible, key=lambda m: (m['specificity'], m['threshold']))

def fit(run, target):
    with np.load(run / 'validation_slide_predictions.npz', allow_pickle=False) as d:
        x, y, ids = logits(d['base']), d['y'].astype(int), d['slide_ids'].copy()
    if len(np.unique(ids)) != len(ids) or not np.isin(y,[0,1]).all() or np.bincount(y, minlength=2).min()<10:
        raise ValueError('Require unique slides and at least 10 validation slides per class.')
    outer = StratifiedKFold(5, shuffle=True, random_state=42)
    p = np.empty(len(y))
    model = estimator()
    for fold, (train, held) in enumerate(outer.split(x,y),1):
        fitted = clone(model).fit(x[train],y[train])
        p[held] = fitted.predict_proba(x[held])[:,1]
        print(f'Completed development fold {fold}/5', flush=True)
    selected = operating_threshold(y,p,target)
    model.fit(x,y)
    out = run / 'reliability_candidate'
    out.mkdir(exist_ok=True)
    artifact = dict(model=model, order=NAMES, transform='clipped_logit', clip=1e-6,
        threshold=selected['threshold'], sensitivity_target=target,
        clinical_validated=False, input_scope='H&E lymph-node histology; PCam sampled-slide experiment')
    tmp = out / 'ensemble.joblib.tmp'
    joblib.dump(artifact,tmp)
    tmp.replace(out / 'ensemble.joblib')
    report = dict(sample_count=len(y), threshold_selected_development_metrics=selected,
        target_is_research_setting_not_clinical_guarantee=True,
        caveat='Nested OOF scores; operating threshold selected on these same OOF labels. Small development cohort; no independent performance claim.')
    (out / 'development_report.json').write_text(json.dumps(report,indent=2))
    np.savez_compressed(out / 'development_oof.npz', y=y,p=p,slide_ids=ids)
    print(json.dumps(report,indent=2))

def predict(run, raw_slide_probabilities):
    artifact = joblib.load(run / 'reliability_candidate' / 'ensemble.joblib')
    if artifact['order'] != NAMES:
        raise ValueError('Model order mismatch')
    p = artifact['model'].predict_proba(logits(raw_slide_probabilities))[:,1]
    return p, p >= artifact['threshold']

def evaluate(run):
    out = run / 'reliability_candidate'
    if (out / 'exploratory_test_report.json').exists():
        raise RuntimeError('Candidate already evaluated; preserve the report.')
    artifact = joblib.load(out / 'ensemble.joblib')
    with np.load(run / 'test_predictions.npz', allow_pickle=False) as d:
        y, x = d['y'].astype(int), d['base'].copy()
    p,_ = predict(run,x)
    report = summarize(y,p,artifact['threshold'])
    report['status'] = 'Exploratory: previously inspected PCam sampled-slide test cohort; not clinical validation'
    (out / 'exploratory_test_report.json').write_text(json.dumps(report,indent=2))
    np.savez_compressed(out / 'exploratory_test_predictions.npz',y=y,p=p)
    print(json.dumps(report,indent=2))

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=['fit','evaluate'])
    parser.add_argument('--run',type=Path,default=DEFAULT)
    parser.add_argument('--sensitivity-target',type=float,default=.95)
    args = parser.parse_args()
    if not 0 < args.sensitivity_target <= 1:
        parser.error('Sensitivity target must be in (0,1].')
    if args.action == 'fit':
        fit(args.run,args.sensitivity_target)
    else:
        evaluate(args.run)
