export default function SecuritySection() {
  const points = [
    {
      title: "100% Client-Side",
      desc: "Conversion happens entirely in your browser. We never see your files, and they never leave your device.",
      icon: "🔒"
    },
    {
      title: "Powered by WebAssembly",
      desc: "We use a high-performance port of FFmpeg (the gold standard of video tools) compiled to WASM.",
      icon: "⚡"
    },
    {
      title: "No Account Required",
      desc: "Privacy means anonymity. Use the tool instantly without signing up or being tracked.",
      icon: "👤"
    },
    {
      title: "Secure & Transparent",
      desc: "By eliminating the server upload step, we eliminate the biggest security risk in video conversion.",
      icon: "🛡️"
    }
  ];

  return (
    <section className="security-section">
      <div className="security-header">
        <p className="status-kicker">Technology & Privacy</p>
        <h2 className="security-title">How it works behind the scenes</h2>
        <p className="security-intro">
          Most online converters require you to upload your personal videos to their servers. 
          <strong> MOV2MP4 is different.</strong> We bring the software to your browser, not your data to our servers.
        </p>
      </div>

      <div className="security-grid">
        {points.map((point, i) => (
          <div key={i} className="security-card">
            <span className="security-icon">{point.icon}</span>
            <h3>{point.title}</h3>
            <p>{point.desc}</p>
          </div>
        ))}
      </div>

      <div className="security-footer">
        <p>
          Technically curious? This tool utilizes <strong>FFmpeg.wasm</strong> and <strong>SharedArrayBuffer</strong> for multi-threaded performance. 
          Your browser acts as the workstation, ensuring maximum privacy and speed.
        </p>
      </div>
    </section>
  );
}
