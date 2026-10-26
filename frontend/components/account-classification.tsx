type Classification = {
 theme: {label: string};
 labels: readonly {key: string; label: string}[];
};

export function AccountClassification({classification,showTheme=true}: {classification: Classification; showTheme?: boolean}) {
 const visible = classification.labels.slice(0, 2);
 const remaining = classification.labels.slice(2);
 return <div className="account-classification" aria-label={showTheme?'账号主题与分类':'账号分类'}>
  {showTheme&&<span className="account-classification__theme">{classification.theme.label}</span>}
  <div className="account-classification__preview">
   {visible.length ? visible.map((label, index) => <span key={`${label.key}/${index}`}>{label.label}</span>) : <span>暂无确认分类</span>}
  </div>
  {remaining.length > 0 && <details className="account-classification__more">
   <summary>其余 {remaining.length} 个标签</summary>
   <ul>{remaining.map((label, index) => <li key={`${label.key}/${index}`}>{label.label}</li>)}</ul>
  </details>}
 </div>;
}
