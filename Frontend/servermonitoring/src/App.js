  import { useState, useEffect, useRef, useCallback } from "react";
import jsPDF from "jspdf";
import html2canvas from "html2canvas";

  const API_BASE_URL = "http://localhost:5000";

// ── Temporary Dummy Data Mode (set to false to use Flask API) ──
const USE_DUMMY_DATA = true;
const DUMMY_INTERVAL_MS = 3000;
const DUMMY_DATA = [
  {
    created_at: new Date().toISOString(),
    temp: 28.4,
    humdi: 52.1,
    vibra: 1.4,
    noise: 55.2,
    fan_status: "OFF",
    sms_status: "IDLE",
    ac_alert: "Normal",
  },
  {
    created_at: new Date().toISOString(),
    temp: 36.8,
    humdi: 66.2,
    vibra: 4.2,
    noise: 68.9,
    fan_status: "ON",
    sms_status: "IDLE",
    ac_alert: "Medium",
  },
  {
    created_at: new Date().toISOString(),
    temp: 42.3,
    humdi: 78.7,
    vibra: 7.6,
    noise: 92.5,
    fan_status: "ON",
    sms_status: "ON",
    ac_alert: "High",
  },
  {
    created_at: new Date().toISOString(),
    temp: 30.1,
    humdi: 48.9,
    vibra: 2.1,
    noise: 58.3,
    fan_status: "OFF",
    sms_status: "IDLE",
    ac_alert: "Low",
  },
];

// ── Report HTML Templates ──────────────────────────────────────────────────────
// ── Progress Notification Component ────────────────────────────────────────────
function ProgressNotification({ theme, progress, message, error }) {
  if (progress === null && !error) return null;

  return (
    <div style={{
      position: "fixed",
      top: "100px",
      right: "32px",
      background: theme === 'dark' ? "#1e293b" : "#fff",
      border: `2px solid ${error ? "#dc2626" : "#3b82f6"}`,
      borderRadius: "12px",
      padding: "16px 20px",
      boxShadow: theme === 'dark' ? "0 8px 32px rgba(0,0,0,0.5)" : "0 8px 32px rgba(0,0,0,0.1)",
      display: "flex",
      alignItems: "center",
      gap: "12px",
      zIndex: 1000,
      maxWidth: "360px",
      animation: "slideIn 0.3s ease-out",
    }}>
      <div style={{
        fontSize: "20px",
        animation: error ? "none" : "pulse 1.5s infinite",
      }}>
        {error ? "❌" : "📊"}
      </div>
      <div style={{ flex: 1 }}>
        <div style={{
          fontSize: "13px",
          fontWeight: "700",
          color: error ? "#dc2626" : "#3b82f6",
          marginBottom: "4px",
          letterSpacing: "0.05em",
        }}>
          {error ? "Generation Failed" : "Generating..."}
        </div>
        <div style={{
          fontSize: "11px",
          color: theme === 'dark' ? "#cbd5e1" : "#64748b",
          lineHeight: "1.4",
          marginBottom: "6px",
        }}>
          {message}
        </div>
        {!error && (
          <div style={{
            width: "100%",
            height: "4px",
            background: theme === 'dark' ? "#334155" : "#e2e8f0",
            borderRadius: "2px",
            overflow: "hidden",
          }}>
            <div style={{
              width: `${progress}%`,
              height: "100%",
              background: "linear-gradient(90deg, #3b82f6, #2563eb)",
              transition: "width 0.3s ease",
              borderRadius: "2px",
            }} />
          </div>
        )}
      </div>
    </div>
  );
}

// ── PDF & CSV Report Generation Utility Functions ─────────────────────────────
const fetchJson = async (path, options = {}) => {
  const res = await fetch(`${API_BASE_URL}${path}`, options);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `Request failed: ${res.status}`);
  }
  return res.json();
};

const fetchSensorData = async (hoursBack) => {
  try {
    if (USE_DUMMY_DATA) {
      const now = Date.now();
      const intervalMs = DUMMY_INTERVAL_MS;
      const totalPoints = Math.max(
        Math.floor((hoursBack * 60 * 60 * 1000) / intervalMs),
        DUMMY_DATA.length
      );
      return Array.from({ length: totalPoints }, (_, i) => {
        const source = DUMMY_DATA[i % DUMMY_DATA.length];
        return {
          ...source,
          created_at: new Date(now - (totalPoints - 1 - i) * intervalMs).toISOString(),
        };
      });
    }

    const data = await fetchJson(`/sensor_data?hours=${hoursBack}`);

    // Map database columns to parseRow input format
    return (data || []).map(row => ({
      created_at: row.created_at,
      temp: row.temperature_C ?? row.temp ?? row.temp_am2305b,
      humdi: row["humidity_%"] ?? row.humdi ?? row.humidity_am2305b,
      vibra: row.vibration_g ?? row.vibra ?? row.vibration,
      noise: row.noise_dB ?? row.noise ?? row.noise_db,
      fan_status: row.fan_status || row.temp_status || 'OFF',
      sms_status: row.sms_status || (row.sms_alert === 'YES' ? 'ON' : 'IDLE') || 'IDLE',
      ac_alert: row.ac_alert || row.dashboard_status || row.final_status || 'Normal',
      temp_status: row.temp_status,
      humidity_status: row.humidity_status,
      vibration_status: row.vibration_status
    }));
  } catch (err) {
    console.error('Failed to fetch sensor data:', err);
    throw err;
  }
};

const predictFromDummy = async (row) => {
  try {
    const payload = {
      temp: row.temp,
      humdi: row.humdi,
      vibra: row.vibra,
      noise: row.noise,
    };
    const res = await fetchJson("/predict", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return res;
  } catch (err) {
    console.error("Predict (dummy) failed:", err);
    return null;
  }
};

// ── Helper: Generate CSV from data with all fields
const generateCSV = (data) => {
  const headers = [
    'Timestamp',
    'Temperature (°C)',
    'Humidity (%)',
    'Vibration (mm/s)',
    'Noise (dB)',
    'Fan Status',
    'SMS Status',
    'Alert Status'
  ];

  const rows = data.map(d => [
    new Date(d.created_at).toLocaleString('en-IN'),
    isNaN(d.temp) ? 'N/A' : d.temp.toFixed(2),
    isNaN(d.humdi) ? 'N/A' : d.humdi.toFixed(2),
    isNaN(d.vibra) ? 'N/A' : d.vibra.toFixed(2),
    isNaN(d.noise) ? 'N/A' : d.noise.toFixed(2),
    d.fan_status || 'OFF',
    d.sms_status || 'IDLE',
    d.ac_alert || 'Normal'
  ]);

  const csv = [headers, ...rows]
    .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    .join('\n');

  return csv;
};

// ── Helper: Generate SVG Line Chart
const generateLineChartSVG = (data, title, fieldKey, unit = '', color = '#3b82f6') => {
  if (!data || data.length === 0) return '';

  const width = 800;
  const height = 300;
  const padding = { top: 20, right: 20, bottom: 40, left: 60 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;

  const values = data.map(d => {
    const val = d[fieldKey];
    return isNaN(val) ? 0 : Number(val);
  });

  if (values.length === 0) return '';

  const minVal = Math.min(...values);
  const maxVal = Math.max(...values);
  const range = maxVal - minVal || 1;
  const avgVal = values.reduce((a, b) => a + b) / values.length;

  let svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">`;
  svg += `<rect width="${width}" height="${height}" fill="#ffffff"/>`;

  // Grid lines
  for (let i = 0; i <= 5; i++) {
    const y = padding.top + (i * plotHeight) / 5;
    const val = maxVal - (i * range) / 5;
    svg += `<line x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}" stroke="#e2e8f0" stroke-width="1"/>`;
    svg += `<text x="30" y="${y + 4}" font-size="11" fill="#64748b" text-anchor="end">${val.toFixed(1)}</text>`;
  }

  // Axes
  svg += `<line x1="${padding.left}" y1="${padding.top}" x2="${padding.left}" y2="${height - padding.bottom}" stroke="#1e293b" stroke-width="2"/>`;
  svg += `<line x1="${padding.left}" y1="${height - padding.bottom}" x2="${width - padding.right}" y2="${height - padding.bottom}" stroke="#1e293b" stroke-width="2"/>`;

  // Y-axis label
  svg += `<text x="15" y="20" font-size="12" fill="#1e293b" font-weight="bold" text-anchor="middle">${unit}</text>`;

  // Plot line
  let points = '';
  values.forEach((val, i) => {
    const x = padding.left + (i / Math.max(values.length - 1, 1)) * plotWidth;
    const y = height - padding.bottom - ((val - minVal) / range) * plotHeight;
    points += `${x},${y} `;
  });
  svg += `<polyline points="${points}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>`;

  // Data points
  values.forEach((val, i) => {
    const x = padding.left + (i / Math.max(values.length - 1, 1)) * plotWidth;
    const y = height - padding.bottom - ((val - minVal) / range) * plotHeight;
    svg += `<circle cx="${x}" cy="${y}" r="3" fill="${color}"/>`;
  });

  // Average line
  const avgY = height - padding.bottom - ((avgVal - minVal) / range) * plotHeight;
  svg += `<line x1="${padding.left}" y1="${avgY}" x2="${width - padding.right}" y2="${avgY}" stroke="#f97316" stroke-width="2" stroke-dasharray="5,5" opacity="0.6"/>`;

  // Title
  svg += `<text x="${width / 2}" y="30" font-size="14" font-weight="bold" fill="#1e293b" text-anchor="middle">${title}</text>`;
  svg += `<text x="${width - padding.right - 150}" y="30" font-size="11" fill="#16a34a" text-anchor="start">Avg: ${avgVal.toFixed(2)} ${unit}</text>`;

  svg += '</svg>';
  return svg;
};




// ── Helper: Convert HTML to PDF using jsPDF and html2canvas
const htmlToPDF = async (htmlContent, filename, onProgress) => {
  try {
    onProgress(60, "Rendering document...");

    // ✅ Create isolated iframe (NO impact on UI)
    const iframe = document.createElement("iframe");
    iframe.style.position = "fixed";
    iframe.style.left = "-9999px";
    iframe.style.top = "0";
    iframe.style.width = "800px";
    iframe.style.height = "3000px";
    iframe.style.border = "0";
    iframe.style.visibility = "hidden";

    document.body.appendChild(iframe);

    const doc = iframe.contentDocument || iframe.contentWindow.document;
    doc.open();
    doc.write(htmlContent);
    doc.close();

    // Wait for render
    await new Promise((res) => setTimeout(res, 300));

    // Adjust iframe to fit exact content height to eliminate bottom whitespace
    const contentHeight = doc.documentElement.scrollHeight;
    iframe.style.height = `${contentHeight}px`;

    const canvas = await html2canvas(doc.body, {
      scale: 2,
      useCORS: true,
      backgroundColor: "#ffffff",
      windowHeight: contentHeight,
      height: contentHeight,
    });

    document.body.removeChild(iframe);

    onProgress(75, "Converting to PDF...");

    const pdf = new jsPDF({
      orientation: "portrait",
      unit: "mm",
      format: "a4",
    });

    const imgData = canvas.toDataURL("image/png");
    const pdfWidth = pdf.internal.pageSize.getWidth();
    const imgWidth = pdfWidth - 20;
    const imgHeight = (canvas.height * imgWidth) / canvas.width;

    let heightLeft = imgHeight;
    const pageHeight = pdf.internal.pageSize.getHeight();
    let position = 10;
    const usableHeight = pageHeight - 20;

    pdf.addImage(imgData, "PNG", 10, position, imgWidth, imgHeight);
    
    // Mask top and bottom margins with white rectangles to prevent content overlapping across pages
    pdf.setFillColor(255, 255, 255);
    pdf.rect(0, 0, pdfWidth, 10, "F");
    pdf.rect(0, pageHeight - 10, pdfWidth, 10, "F");

    heightLeft -= usableHeight;

    // Tolerance of 25mm handles typical CSS bottom paddings/margins avoiding trailing blank pages
    while (heightLeft > 25) {
      position -= usableHeight; 
      pdf.addPage();
      pdf.addImage(imgData, "PNG", 10, position, imgWidth, imgHeight);
      
      pdf.setFillColor(255, 255, 255);
      pdf.rect(0, 0, pdfWidth, 10, "F");
      pdf.rect(0, pageHeight - 10, pdfWidth, 10, "F");
      
      heightLeft -= usableHeight;
    }

    onProgress(90, "Finalizing PDF...");
    pdf.save(filename);

    onProgress(100, "Downloaded successfully!");
    setTimeout(() => onProgress(null), 2000);

  } catch (err) {
    console.error("PDF conversion error:", err);
    throw new Error("Failed to generate PDF. Please try again.");
  }
};

const generateDailyChartsPDF = async (data, onProgress) => {
  try {
    onProgress(20, "Processing sensor data...");
    
    const tempData = data.map(d => d.temp || 0);
    const humData = data.map(d => d.humdi || 0);
    const vibData = data.map(d => d.vibra || 0);
    const noiseData = data.map(d => d.noise || 0);

    const stats = {
      temp: { min: Math.min(...tempData), max: Math.max(...tempData), avg: tempData.reduce((a, b) => a + b) / tempData.length },
      hum: { min: Math.min(...humData), max: Math.max(...humData), avg: humData.reduce((a, b) => a + b) / humData.length },
      vib: { min: Math.min(...vibData), max: Math.max(...vibData), avg: vibData.reduce((a, b) => a + b) / vibData.length },
      noise: { min: Math.min(...noiseData), max: Math.max(...noiseData), avg: noiseData.reduce((a, b) => a + b) / noiseData.length }
    };

    onProgress(40, "Generating charts...");

    const chartTemp = generateLineChartSVG(data, 'Temperature Trend (24H)', 'temp', '°C', '#ef4444');
    const chartHum = generateLineChartSVG(data, 'Humidity Trend (24H)', 'humdi', '%', '#3b82f6');
    const chartVib = generateLineChartSVG(data, 'Vibration Trend (24H)', 'vibra', 'mm/s', '#f59e0b');
    const chartNoise = generateLineChartSVG(data, 'Noise Trend (24H)', 'noise', 'dB', '#8b5cf6');

    onProgress(60, "Creating report layout...");

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body { font-family: 'Segoe UI', Arial, sans-serif; background: #f8fafc; padding: 20px; }
          .page { background: white; padding: 40px; margin-bottom: 20px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
          .header { 
            background: linear-gradient(135deg, #3b82f6, #2563eb);
            color: white;
            padding: 30px;
            border-radius: 8px;
            margin-bottom: 30px;
            text-align: center;
          }
          .header h1 { font-size: 28px; margin-bottom: 5px; }
          .header p { opacity: 0.9; font-size: 14px; margin: 3px 0; }
          .section { margin: 30px 0; }
          .section-title { 
            font-size: 16px; 
            font-weight: bold; 
            color: #1e293b; 
            margin-bottom: 15px;
            border-bottom: 3px solid #3b82f6;
            padding-bottom: 10px;
          }
          .stats-grid { display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 15px; margin: 20px 0; }
          .stat-box { 
            padding: 15px; 
            background: linear-gradient(135deg, #f0f9ff, #e0f2fe);
            border-radius: 8px; 
            border-left: 4px solid #3b82f6;
            text-align: center;
          }
          .stat-label { font-size: 12px; color: #64748b; font-weight: bold; text-transform: uppercase; }
          .stat-value { font-size: 20px; color: #1e293b; font-weight: bold; margin-top: 5px; }
          .stat-unit { font-size: 11px; color: #94a3b8; margin-top: 3px; }
          .chart { margin: 20px 0; display: flex; justify-content: center; }
          .footer { margin-top: 40px; padding-top: 20px; border-top: 1px solid #e2e8f0; text-align: center; color: #94a3b8; font-size: 11px; }
        </style>
      </head>
      <body>
        <div class="page">
          <div class="header">
            <h1>📊 24-Hour Sensor Charts Report</h1>
            <p><strong>Smart Rack Monitoring System - SASTRA</strong></p>
            <p>${new Date().toLocaleDateString('en-IN')} | ${new Date().toLocaleTimeString('en-IN')}</p>
          </div>

          <div class="section">
            <div class="section-title">TEMPERATURE ANALYSIS</div>
            <div class="stats-grid">
              <div class="stat-box">
                <div class="stat-label">Minimum</div>
                <div class="stat-value">${stats.temp.min.toFixed(1)}</div>
                <div class="stat-unit">°C</div>
              </div>
              <div class="stat-box">
                <div class="stat-label">Maximum</div>
                <div class="stat-value">${stats.temp.max.toFixed(1)}</div>
                <div class="stat-unit">°C</div>
              </div>
              <div class="stat-box">
                <div class="stat-label">Average</div>
                <div class="stat-value">${stats.temp.avg.toFixed(1)}</div>
                <div class="stat-unit">°C</div>
              </div>
              <div class="stat-box">
                <div class="stat-label">Readings</div>
                <div class="stat-value">${data.length}</div>
                <div class="stat-unit">24H</div>
              </div>
            </div>
            <div class="chart">${chartTemp}</div>
          </div>

          <div class="section">
            <div class="section-title">HUMIDITY ANALYSIS</div>
            <div class="stats-grid">
              <div class="stat-box">
                <div class="stat-label">Minimum</div>
                <div class="stat-value">${stats.hum.min.toFixed(1)}</div>
                <div class="stat-unit">%</div>
              </div>
              <div class="stat-box">
                <div class="stat-label">Maximum</div>
                <div class="stat-value">${stats.hum.max.toFixed(1)}</div>
                <div class="stat-unit">%</div>
              </div>
              <div class="stat-box">
                <div class="stat-label">Average</div>
                <div class="stat-value">${stats.hum.avg.toFixed(1)}</div>
                <div class="stat-unit">%</div>
              </div>
              <div class="stat-box">
                <div class="stat-label">Stability</div>
                <div class="stat-value">${((100 - (stats.hum.max - stats.hum.min)) * 1).toFixed(0)}</div>
                <div class="stat-unit">%</div>
              </div>
            </div>
            <div class="chart">${chartHum}</div>
          </div>



          <div class="section">
            <div class="section-title">VIBRATION ANALYSIS</div>
            <div class="stats-grid">
              <div class="stat-box">
                <div class="stat-label">Minimum</div>
                <div class="stat-value">${stats.vib.min.toFixed(2)}</div>
                <div class="stat-unit">mm/s</div>
              </div>
              <div class="stat-box">
                <div class="stat-label">Maximum</div>
                <div class="stat-value">${stats.vib.max.toFixed(2)}</div>
                <div class="stat-unit">mm/s</div>
              </div>
              <div class="stat-box">
                <div class="stat-label">Average</div>
                <div class="stat-value">${stats.vib.avg.toFixed(2)}</div>
                <div class="stat-unit">mm/s</div>
              </div>
              <div class="stat-box">
                <div class="stat-label">Status</div>
                <div class="stat-value" style="color: ${stats.vib.max > 7 ? '#dc2626' : '#16a34a'}">${stats.vib.max > 7 ? '⚠️ HIGH' : '✅ SAFE'}</div>
              </div>
            </div>
            <div class="chart">${chartVib}</div>
          </div>

          <div class="section">
            <div class="section-title">NOISE ANALYSIS</div>
            <div class="stats-grid">
              <div class="stat-box">
                <div class="stat-label">Minimum</div>
                <div class="stat-value">${stats.noise.min.toFixed(2)}</div>
                <div class="stat-unit">dB</div>
              </div>
              <div class="stat-box">
                <div class="stat-label">Maximum</div>
                <div class="stat-value">${stats.noise.max.toFixed(2)}</div>
                <div class="stat-unit">dB</div>
              </div>
              <div class="stat-box">
                <div class="stat-label">Average</div>
                <div class="stat-value">${stats.noise.avg.toFixed(2)}</div>
                <div class="stat-unit">dB</div>
              </div>
              <div class="stat-box">
                <div class="stat-label">Status</div>
                <div class="stat-value" style="color: ${stats.noise.max > 85 ? '#dc2626' : '#16a34a'}">${stats.noise.max > 85 ? '⚠️ LOUD' : '✅ NORMAL'}</div>
              </div>
            </div>
            <div class="chart">${chartNoise}</div>
          </div>

          <div class="footer">
            <p>Report Generated: ${new Date().toLocaleString('en-IN')}</p>
            <p>© SASTRA Deemed to be University - Smart Rack Monitoring System | Confidential</p>
          </div>
        </div>
      </body>
      </html>
    `;

    await htmlToPDF(html, `CHARTS_24H_${new Date().toISOString().split('T')[0]}.pdf`, onProgress);
  } catch (err) {
    console.error('Chart PDF generation error:', err);
    throw err;
  }
};


const generateDailyGraphsPDF = async (data, onProgress) => {
  try {
    onProgress(10, "Preparing data export...");
    
    // Export raw sensor data as CSV with all fields
    const csv = generateCSV(data);
    
    onProgress(50, "Creating CSV file...");

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `SENSOR_DATA_24H_${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    window.URL.revokeObjectURL(url);

    onProgress(100, "CSV downloaded successfully!");
    setTimeout(() => onProgress(null), 2000);
  } catch (err) {
    console.error('CSV export error:', err);
    throw err;
  }
};

const generateDailyReportPDF = async (data, onProgress) => {
  try {
    onProgress(15, "Analyzing system status...");
    
    const criticalCount = data.filter(d => d.ac_alert === "High").length;
    const warningCount = data.filter(d => d.ac_alert === "Medium").length;
    const normalCount = data.filter(d => d.ac_alert === "Low" || d.ac_alert === "Normal").length;

    onProgress(35, "Generating statistics...");

    const tempData = data.map(d => d.temp || 0);
    const humData = data.map(d => d.humdi || 0);
    const vibData = data.map(d => d.vibra || 0);
    const noiseData = data.map(d => d.noise || 0);

    const highTempEvents = data.filter(d => d.temp > 40).length;
    const lowTempEvents = data.filter(d => d.temp < 15).length;
    const highHumEvents = data.filter(d => d.humdi > 80).length;
    const lowHumEvents = data.filter(d => d.humdi < 30).length;

    onProgress(50, "Creating report layout...");

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body { font-family: 'Segoe UI', Arial, sans-serif; background: #f8fafc; padding: 20px; }
          .page { background: white; padding: 40px; margin-bottom: 20px; }
          .header { 
            background: linear-gradient(135deg, #10b981, #059669);
            color: white;
            padding: 30px;
            border-radius: 8px;
            margin-bottom: 30px;
            text-align: center;
          }
          .header h1 { font-size: 28px; margin-bottom: 5px; }
          .header p { opacity: 0.9; font-size: 14px; margin: 3px 0; }
          .alert-box { 
            background: #fef3c7;
            border-left: 4px solid #f59e0b;
            padding: 15px;
            margin: 20px 0;
            border-radius: 4px;
          }
          .alert-box.critical {
            background: #fee2e2;
            border-left-color: #dc2626;
          }
          .alert-title { font-weight: bold; color: #1e293b; margin-bottom: 5px; }
          .alert-message { font-size: 13px; color: #475569; }
          .status-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 15px; margin: 20px 0; }
          .status-card { 
            padding: 20px; 
            border-radius: 8px; 
            text-align: center; 
            border-top: 4px solid;
          }
          .status-card.critical { background: #fff5f5; border-top-color: #dc2626; }
          .status-card.warning { background: #fff7ed; border-top-color: #f97316; }
          .status-card.normal { background: #f0fdf4; border-top-color: #16a34a; }
          .status-number { font-size: 32px; font-weight: bold; }
          .status-label { font-size: 12px; color: #64748b; margin-top: 5px; text-transform: uppercase; }
          .section { margin: 30px 0; }
          .section-title { 
            font-size: 16px; 
            font-weight: bold; 
            color: #1e293b; 
            margin-bottom: 15px;
            border-bottom: 3px solid #10b981;
            padding-bottom: 10px;
          }
          table { width: 100%; border-collapse: collapse; margin: 15px 0; }
          th { 
            background: #ecfdf5; 
            padding: 12px; 
            text-align: left; 
            font-weight: bold;
            color: #047857;
            border-bottom: 2px solid #10b981;
          }
          td { padding: 10px 12px; border-bottom: 1px solid #e2e8f0; }
          tr:hover { background: #f0fdf4; }
          .metric-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin: 15px 0; }
          .metric-item { padding: 12px; background: #f8fafc; border-left: 3px solid #10b981; border-radius: 4px; }
          .metric-label { font-size: 12px; color: #64748b; font-weight: bold; }
          .metric-value { font-size: 18px; color: #047857; font-weight: bold; margin-top: 5px; }
          .footer { margin-top: 40px; padding-top: 20px; border-top: 1px solid #e2e8f0; text-align: center; color: #94a3b8; font-size: 11px; }
          .conclusion { 
            background: #ecfdf5; 
            padding: 15px; 
            border-radius: 8px; 
            margin: 20px 0;
            border-left: 4px solid #10b981;
          }
        </style>
      </head>
      <body>
        <div class="page">
          <div class="header">
            <h1>📋 Daily Comprehensive Report</h1>
            <p><strong>Smart Rack Monitoring System - SASTRA</strong></p>
            <p>${new Date().toLocaleDateString('en-IN')} | ${new Date().toLocaleTimeString('en-IN')}</p>
          </div>

          ${criticalCount > 0 ? `
            <div class="alert-box critical">
              <div class="alert-title">⚠️ CRITICAL ALERT</div>
              <div class="alert-message">${criticalCount} critical events detected in this 24-hour period. Immediate review recommended.</div>
            </div>
          ` : `
            <div class="alert-box">
              <div class="alert-title">✅ System Status: NORMAL</div>
              <div class="alert-message">All systems operating within normal parameters. No critical alerts detected.</div>
            </div>
          `}

          <div class="section">
            <div class="section-title">SYSTEM STATUS OVERVIEW</div>
            <div class="status-grid">
              <div class="status-card ${criticalCount > 0 ? 'critical' : 'normal'}">
                <div class="status-number">${criticalCount}</div>
                <div class="status-label">🔴 Critical Events</div>
              </div>
              <div class="status-card ${warningCount > 3 ? 'warning' : 'normal'}">
                <div class="status-number">${warningCount}</div>
                <div class="status-label">🟠 Warning Events</div>
              </div>
              <div class="status-card normal">
                <div class="status-number">${normalCount}</div>
                <div class="status-label">🟢 Normal Events</div>
              </div>
            </div>
          </div>

          <div class="section">
            <div class="section-title">SENSOR PERFORMANCE DETAILED</div>
            <table>
              <tr>
                <th>Sensor</th>
                <th>Minimum</th>
                <th>Maximum</th>
                <th>Average</th>
                <th>Status</th>
              </tr>
              <tr>
                <td style="font-weight: bold;">🌡️ Temperature</td>
                <td>${Math.min(...tempData).toFixed(2)}°C</td>
                <td>${Math.max(...tempData).toFixed(2)}°C</td>
                <td>${(tempData.reduce((a, b) => a + b) / tempData.length).toFixed(2)}°C</td>
                <td>${Math.max(...tempData) > 40 ? '⚠️ HIGH' : '✅ NORMAL'}</td>
              </tr>
              <tr>
                <td style="font-weight: bold;">💧 Humidity</td>
                <td>${Math.min(...humData).toFixed(2)}%</td>
                <td>${Math.max(...humData).toFixed(2)}%</td>
                <td>${(humData.reduce((a, b) => a + b) / humData.length).toFixed(2)}%</td>
                <td>${Math.max(...humData) > 80 ? '⚠️ HIGH' : '✅ NORMAL'}</td>
              </tr>

              <tr>
                <td style="font-weight: bold;">📳 Vibration</td>
                <td>${Math.min(...vibData).toFixed(2)} mm/s</td>
                <td>${Math.max(...vibData).toFixed(2)} mm/s</td>
                <td>${(vibData.reduce((a, b) => a + b) / vibData.length).toFixed(2)} mm/s</td>
                <td>${Math.max(...vibData) > 7 ? '⚠️ HIGH' : '✅ SAFE'}</td>
              </tr>
              <tr>
                <td style="font-weight: bold;">🔊 Noise</td>
                <td>${Math.min(...noiseData).toFixed(2)} dB</td>
                <td>${Math.max(...noiseData).toFixed(2)} dB</td>
                <td>${(noiseData.reduce((a, b) => a + b) / noiseData.length).toFixed(2)} dB</td>
                <td>${Math.max(...noiseData) > 85 ? '⚠️ LOUD' : '✅ NORMAL'}</td>
              </tr>
            </table>
          </div>

          <div class="section">
            <div class="section-title">ANOMALY DETECTION</div>
            <div class="metric-grid">
              <div class="metric-item">
                <div class="metric-label">High Temperature Events (>40°C)</div>
                <div class="metric-value">${highTempEvents}</div>
              </div>
              <div class="metric-item">
                <div class="metric-label">Low Temperature Events (<15°C)</div>
                <div class="metric-value">${lowTempEvents}</div>
              </div>
              <div class="metric-item">
                <div class="metric-label">High Humidity Events (>80%)</div>
                <div class="metric-value">${highHumEvents}</div>
              </div>
              <div class="metric-item">
                <div class="metric-label">Low Humidity Events (<30%)</div>
                <div class="metric-value">${lowHumEvents}</div>
              </div>
            </div>
          </div>

          <div class="section">
            <div class="conclusion">
              <strong>Conclusion:</strong> 
              ${criticalCount === 0 ? 'The Smart Rack Monitoring System maintained optimal operating conditions throughout the 24-hour monitoring period. All sensors performed within expected ranges with no critical incidents.' : 
              `${criticalCount} critical events were detected. Immediate corrective action is recommended to prevent equipment damage or service disruption.`}
            </div>
          </div>

          <div class="footer">
            <p>Report Generated: ${new Date().toLocaleString('en-IN')}</p>
            <p>© SASTRA Deemed to be University - Smart Rack Monitoring System | Confidential</p>
          </div>
        </div>
      </body>
      </html>
    `;

    await htmlToPDF(html, `REPORT_24H_${new Date().toISOString().split('T')[0]}.pdf`, onProgress);
  } catch (err) {
    console.error('Report PDF generation error:', err);
    throw err;
  }
};

const generateSummaryPDF = async (data, onProgress) => {
  try {
    onProgress(20, "Calculating metrics...");

    const systemUptime = (data.filter(d => d.ac_alert !== "High").length / data.length * 100).toFixed(1);
    const avgTemp = (data.reduce((a, b) => a + (b.temp || 0), 0) / data.length).toFixed(2);
    const avgHum = (data.reduce((a, b) => a + (b.humdi || 0), 0) / data.length).toFixed(2);
    const peakTemp = Math.max(...data.map(d => d.temp || 0)).toFixed(2);
    const peakHum = Math.max(...data.map(d => d.humdi || 0)).toFixed(2);

    onProgress(60, "Creating executive summary...");

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body { font-family: 'Segoe UI', Arial, sans-serif; background: #f8fafc; padding: 20px; }
          .page { background: white; padding: 40px; margin-bottom: 20px; }
          .header { 
            background: linear-gradient(135deg, #f59e0b, #d97706);
            color: white;
            padding: 40px;
            border-radius: 8px;
            margin-bottom: 30px;
            text-align: center;
          }
          .header h1 { font-size: 32px; margin-bottom: 10px; font-weight: bold; }
          .header .subtitle { font-size: 16px; opacity: 0.9; margin-bottom: 5px; }
          .header .period { font-size: 12px; opacity: 0.8; }
          .kpi-section { 
            background: linear-gradient(135deg, #fef3c7, #fef08a);
            padding: 25px;
            border-radius: 8px;
            margin: 25px 0;
            border-left: 5px solid #f59e0b;
          }
          .kpi-title { font-size: 16px; font-weight: bold; color: #1e293b; margin-bottom: 15px; }
          .kpi-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 15px; }
          .kpi-card { 
            background: white;
            padding: 20px;
            border-radius: 8px;
            border-top: 3px solid #f59e0b;
            text-align: center;
            box-shadow: 0 2px 4px rgba(0,0,0,0.05);
          }
          .kpi-value { font-size: 28px; font-weight: bold; color: #d97706; margin: 10px 0; }
          .kpi-label { font-size: 12px; color: #64748b; text-transform: uppercase; font-weight: bold; }
          .section { margin: 30px 0; }
          .section-title { 
            font-size: 16px; 
            font-weight: bold; 
            color: #1e293b; 
            margin-bottom: 15px;
            border-bottom: 3px solid #f59e0b;
            padding-bottom: 10px;
          }
          .metrics-box { 
            display: grid; 
            grid-template-columns: 1fr 1fr; 
            gap: 15px; 
            margin: 15px 0;
          }
          .metric-item {
            padding: 15px;
            background: #fffbeb;
            border-left: 3px solid #f59e0b;
            border-radius: 4px;
          }
          .metric-label { font-size: 12px; color: #92400e; font-weight: bold; }
          .metric-value { font-size: 20px; color: #d97706; font-weight: bold; margin-top: 5px; }
          .exec-summary {
            background: linear-gradient(135deg, #fef0e7, #fef3c7);
            padding: 20px;
            border-radius: 8px;
            border-left: 4px solid #f97316;
            margin: 20px 0;
          }
          .exec-summary h3 { color: #92400e; margin-bottom: 10px; }
          .exec-summary p { color: #78350f; line-height: 1.6; font-size: 13px; }
          .recommendations { 
            background: #f0fdf4;
            padding: 15px;
            border-radius: 8px;
            border-left: 4px solid #16a34a;
            margin: 15px 0;
          }
          .recommendations h4 { color: #15803d; margin-bottom: 8px; }
          .recommendations ul { margin-left: 20px; color: #47563e; font-size: 13px; }
          .recommendations li { margin: 5px 0; }
          .footer { margin-top: 40px; padding-top: 20px; border-top: 1px solid #e2e8f0; text-align: center; color: #94a3b8; font-size: 11px; }
        </style>
      </head>
      <body>
        <div class="page">
          <div class="header">
            <h1>📋 Executive Summary</h1>
            <div class="subtitle">24-Hour System Performance Overview</div>
            <div class="period">Smart Rack Monitoring System - SASTRA</div>
            <div class="period">${new Date().toLocaleDateString('en-IN')}</div>
          </div>

          <div class="kpi-section">
            <div class="kpi-title">KEY PERFORMANCE INDICATORS</div>
            <div class="kpi-grid">
              <div class="kpi-card">
                <div class="kpi-label">System Uptime</div>
                <div class="kpi-value">${systemUptime}%</div>
              </div>
              <div class="kpi-card">
                <div class="kpi-label">Avg Temperature</div>
                <div class="kpi-value">${avgTemp}°C</div>
              </div>
              <div class="kpi-card">
                <div class="kpi-label">Avg Humidity</div>
                <div class="kpi-value">${avgHum}%</div>
              </div>
            </div>
          </div>

          <div class="section">
            <div class="section-title">OPERATIONAL METRICS</div>
            <div class="metrics-box">

              <div class="metric-item">
                <div class="metric-label">Peak Temperature</div>
                <div class="metric-value">${peakTemp}°C</div>
              </div>
              <div class="metric-item">
                <div class="metric-label">Peak Humidity</div>
                <div class="metric-value">${peakHum}%</div>
              </div>
            </div>
          </div>

          <div class="exec-summary">
            <h3>📌 Executive Summary</h3>
            <p>
              The Smart Rack Monitoring System sustained ${systemUptime}% operational uptime during the 24-hour monitoring period. 
              Environmental conditions remained stable with average temperature at ${avgTemp}°C and humidity at ${avgHum}%. 
              All monitored systems maintained normal operational status with no critical incidents reported.
            </p>
          </div>

          <div class="recommendations">
            <h4>✅ Operational Recommendations</h4>
            <ul>
              <li>Continue routine monitoring and maintenance schedule</li>
              <li>Maintain temperature setpoint between 20-25°C for optimal equipment performance</li>
              <li>Ensure humidity levels remain between 30-50% RH</li>
              <li>Monthly inspection of cooling system efficiency</li>
              <li>Quarterly system performance audit recommended</li>
            </ul>
          </div>

          <div class="footer">
            <p>Report Generated: ${new Date().toLocaleString('en-IN')}</p>
            <p>© SASTRA Deemed to be University - Smart Rack Monitoring System | Confidential - For Authorized Personnel Only</p>
          </div>
        </div>
      </body>
      </html>
    `;

    await htmlToPDF(html, `EXECUTIVE_SUMMARY_${new Date().toISOString().split('T')[0]}.pdf`, onProgress);
  } catch (err) {
    console.error('Summary PDF generation error:', err);
    throw err;
  }
};

const TEMP_WARN_MIN = 30;
const TEMP_CRIT_MIN = 37;
const HUM_WARN_MIN = 35;
const HUM_WARN_MAX = 65;
const HUM_NORM_MIN = 45;
const HUM_NORM_MAX = 55;
const VIB_WARN_MIN = 0.48;
const VIB_CRIT_MIN = 0.75;
const NOISE_WARN_MIN = 50;
const NOISE_CRIT_MIN = 53;

const stageToStatus = (stage) => {
  if (stage === "Critical") return "High";
  if (stage === "Warning") return "Medium";
  return "Normal";
};

const stageMessage = (stage) => {
  if (stage === "Critical") return "Critical";
  if (stage === "Warning") return "Warning";
  return "No Action";
};

function classifyTemp(temp) {
  if (temp == null || Number.isNaN(temp)) return "Normal";
  if (temp > TEMP_CRIT_MIN) return "Critical";
  if (temp >= TEMP_WARN_MIN) return "Warning";
  return "Normal";
}

function classifyHumidity(humdi) {
  if (humdi == null || Number.isNaN(humdi)) return "Normal";
  if (humdi < HUM_WARN_MIN || humdi > HUM_WARN_MAX) return "Critical";
  if (humdi < HUM_NORM_MIN || humdi > HUM_NORM_MAX) return "Warning";
  return "Normal";
}

function classifyVibration(vibra) {
  if (vibra == null || Number.isNaN(vibra)) return "Normal";
  if (vibra > VIB_CRIT_MIN) return "Critical";
  if (vibra >= VIB_WARN_MIN) return "Warning";
  return "Normal";
}

function classifyNoise(noise) {
  if (noise == null || Number.isNaN(noise)) return "Normal";
  if (noise > NOISE_CRIT_MIN) return "Critical";
  if (noise >= NOISE_WARN_MIN) return "Warning";
  return "Normal";
}

function parseRow(r) {
  const sensor = r?.sensor_readings || r || {};
  const temp = sensor.temperature_C ?? r.temp ?? r.temp_am2305b ?? r.temperature;
  const humdi = sensor["humidity_%"] ?? r.humdi ?? r.humidity_am2305b ?? r.humidity;
  const vibra = sensor.vibration_g ?? r.vibra ?? r.vibration ?? r.vibration_g;
  const noise = sensor.noise_dB ?? r.noise ?? r.noise_db ?? r.noise_dB;

  const tempStage = classifyTemp(temp);
  const humStage = classifyHumidity(humdi);
  const vibStage = classifyVibration(vibra);
  const noiseStage = classifyNoise(noise);

  const isTempWarn = tempStage === "Warning";
  const isTempCrit = tempStage === "Critical";
  const isHumCrit = humStage === "Critical";
  const isVibWarn = vibStage === "Warning" || vibStage === "Critical";
  const isVibCrit = vibStage === "Critical";
  const isNoiseWarn = noiseStage === "Warning" || noiseStage === "Critical";
  const isNoiseCrit = noiseStage === "Critical";

  const earlyFailure = isTempWarn && isVibWarn && isNoiseWarn;

  const fanOn = isTempCrit || isVibCrit || isNoiseCrit || (isTempWarn && (isVibWarn || isNoiseWarn));
  const smsOn = isTempCrit || isHumCrit || isVibCrit || isNoiseCrit || earlyFailure;

  const warningCount = [tempStage, humStage, vibStage, noiseStage].filter((s) => s === "Warning").length;
  const hasCritical = [tempStage, humStage, vibStage, noiseStage].some((s) => s === "Critical");
  const dashboardWarning = hasCritical || warningCount >= 2 || isTempWarn || (vibStage === "Warning" && noiseStage === "Warning");

  const overall = hasCritical ? "High" : dashboardWarning ? "Medium" : "Normal";

  return {
    temp: temp,
    hum: humdi,
    vib: vibra,
    noise: noise,

    temp_s: stageToStatus(tempStage),
    hum_s: stageToStatus(humStage),
    vib_s: stageToStatus(vibStage),
    noise_s: stageToStatus(noiseStage),

    temp_msg: stageMessage(tempStage),
    hum_msg: stageMessage(humStage),
    vib_msg: stageMessage(vibStage),
    noise_msg: stageMessage(noiseStage),

    overall: overall,
    cur: r.prediction || r.cur,
    actions: {
      fan: fanOn,
      sms: smsOn,
      dashboard: dashboardWarning || hasCritical,
    },

    fan: fanOn,
    sms: smsOn,
  };
}

// Status colors — green/orange/red on white background
const SC = {
  High:   { fill:"#dc2626", track:"#fecaca", text:"#dc2626", bg:"#fff5f5", border:"#fca5a5", label:"CRITICAL" },
  Medium: { fill:"#f97316", track:"#fed7aa", text:"#ea580c", bg:"#fff7ed", border:"#fdba74", label:"WARNING"  },
  Low:    { fill:"#16a34a", track:"#bbf7d0", text:"#15803d", bg:"#f0fdf4", border:"#86efac", label:"NORMAL"   },
  Normal: { fill:"#16a34a", track:"#bbf7d0", text:"#15803d", bg:"#f0fdf4", border:"#86efac", label:"NORMAL"   },
};

// ── Skeleton Loader Components ─────────────────────────────────────────────────
function SkeletonGauge({ theme }) {
  const isDark = theme === 'dark';
  const bgColor = isDark ? "#1e293b" : "#f0fdf4";
  const borderColor = isDark ? "#334155" : "#e2e8f0";
  
  return (
    <div style={{
      background: bgColor,
      border: `1.5px solid ${borderColor}`,
      borderRadius: "16px",
      padding: "18px 14px 14px",
      display: "flex", flexDirection: "column", alignItems: "center",
      boxShadow: isDark ? `0 2px 12px rgba(0,0,0,0.3)` : `0 2px 12px rgba(0,0,0,0.1)`,
      justifyContent: "space-evenly",
    }}>
      <div style={{
        position: "absolute", top: "12px", right: "12px",
        fontSize: "9px", fontWeight: "800", letterSpacing: "0.1em",
        padding: "2px 8px", borderRadius: "20px",
        background: isDark ? "#475569" : "#cbd5e1", color: isDark ? "#1e293b" : "#f1f5f9",
        animation: "pulse 2s infinite",
      }}>—</div>

      <div style={{
        fontSize: "11px", fontWeight: "700",
        color: isDark ? "#cbd5e1" : "#64748b",
        letterSpacing: "0.08em", marginBottom: "12px",
      }}>—</div>

      <svg width="128" height="124" style={{ margin: "10px 0", animation: "pulse 2s infinite" }}>
        <circle cx="64" cy="62" r="52" fill="none" stroke={isDark ? "#334155" : "#cbd5e1"} strokeWidth="6" opacity="0.3" />
      </svg>

      <div style={{
        fontSize: "13px", fontWeight: "700",
        color: isDark ? "#475569" : "#cbd5e1",
        marginBottom: "8px", animation: "pulse 2s infinite",
      }}>—</div>
    </div>
  );
}

function SkeletonPredictionPanel({ theme }) {
  const isDark = theme === 'dark';
  const boxColor = isDark ? "#0f172a" : "#f1f5f9";
  
  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "1fr 1fr",
      gap: "4px",
      flex: 1,
      overflow: "hidden",
      height: "90%",
    }}>
      {[1, 2, 3, 4].map(i => (
        <div key={i} style={{
          background: boxColor,
          border: `1.5px solid ${isDark ? "#334155" : "#e2e8f0"}`,
          borderRadius: "8px",
          padding: "4px",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "center",
          animation: "pulse 2s infinite",
        }}>
          <div style={{
            fontSize: "12px",
            color: isDark ? "#475569" : "#cbd5e1",
            fontWeight: "600",
            marginBottom: "4px",
            height: "12px",
            width: "50%",
            borderRadius: "4px",
            background: isDark ? "#475569" : "#cbd5e1",
          }} />
          <div style={{
            fontSize: "18px",
            fontWeight: "800",
            color: isDark ? "#334155" : "#cbd5e1",
            height: "18px",
            width: "60%",
            borderRadius: "4px",
            background: isDark ? "#334155" : "#cbd5e1",
            marginTop: "4px",
          }} />
        </div>
      ))}
    </div>
  );
}

function SkeletonAdminButton({ theme }) {
  const isDark = theme === 'dark';
  return (
    <div style={{
      padding: "10px 12px",
      background: isDark ? "#334155" : "#cbd5e1",
      borderRadius: "8px",
      height: "100%",
      animation: "pulse 2s infinite",
      opacity: 0.5,
    }} />
  );
}

const SENSORS = [
  { key:"temp",  label:"Temperature", unit:"°C", icon:"🌡", sk:"temp_s",  mk:"temp_msg",  min:20, max:50,  warn:TEMP_WARN_MIN,  crit:TEMP_CRIT_MIN },
  { key:"hum",   label:"Humidity",    unit:"%",  icon:"💧", sk:"hum_s",   mk:"hum_msg",   min:0,  max:100, warn:HUM_NORM_MAX,    crit:HUM_WARN_MAX },
  { key:"vib",   label:"Vibration",   unit:"g",  icon:"📳", sk:"vib_s",   mk:"vib_msg",   min:0,  max:1.5, warn:VIB_WARN_MIN,   crit:VIB_CRIT_MIN },
  { key:"noise", label:"Noise",       unit:"dB", icon:"🔊", sk:"noise_s", mk:"noise_msg", min:30, max:120, warn:NOISE_WARN_MIN, crit:NOISE_CRIT_MIN },
];

// ── Arc Gauge ─────────────────────────────────────────────────────────────────
function ArcGauge({ value, min, max, warn, crit, status, label, unit, icon, msg, theme }) {
  const sc  = SC[status] || SC.Normal;
  const isDark = theme === 'dark';
  const pct = Math.min(Math.max((value - min) / (max - min), 0), 1);
  const ang = pct * 180;

  const R = 52, cx = 64, cy = 62;
  const rad = (deg) => ((180 - deg) * Math.PI) / 180;
  const pt  = (deg) => ({
    x: cx + R * Math.cos(rad(deg)),
    y: cy - R * Math.sin(rad(deg)),
  });

  const start  = pt(0);
  const end    = pt(ang);
  const wEnd   = pt(((warn - min) / (max - min)) * 180);
  const cEnd   = pt(((crit - min) / (max - min)) * 180);
  const large  = ang > 180 ? 1 : 0;

  const dispVal = value != null
    ? (unit === "kW" ? (value / 1000).toFixed(2) : value.toFixed(value < 10 ? 2 : 1))
    : "—";

  const bgColor = isDark ? "#1e293b" : sc.bg;
  const borderColor = isDark ? "#334155" : sc.border;
  const labelColor = isDark ? "#94a3b8" : "#64748b";
  const textBgColor = isDark ? "#0f172a" : "#fff";
  const needleColor = isDark ? "#e2e8f0" : "#1e293b";

  return (
    <div style={{
      background: bgColor,
      border: `1.5px solid ${borderColor}`,
      borderRadius: "16px",
      padding: "18px 14px 14px",
      display: "flex", flexDirection: "column", alignItems: "center",
      boxShadow: isDark ? `0 2px 12px rgba(0,0,0,0.3)` : `0 2px 12px ${sc.fill}22`,
      transition: "all 0.5s ease",
      position: "relative",
      justifyContent:"space-evenly"
    }}>
      {/* Status badge top-right */}
      <div style={{
        position: "absolute", top: "12px", right: "12px",
        fontSize: "9px", fontWeight: "800", letterSpacing: "0.1em",
        padding: "2px 8px", borderRadius: "20px",
        background: sc.fill, color: "#fff",
      }}>{sc.label}</div>

      {/* Icon + Label */}
      <div style={{ fontSize: "11px", fontWeight: "700", color: labelColor,
                    letterSpacing: "0.08em", marginBottom: "4px",
                    display: "flex", alignItems: "center", gap: "5px" }}>
        <span style={{ fontSize: "16px" }}>{icon}</span>
        {label.toUpperCase()}
      </div>

      {/* SVG Gauge */}
      <svg viewBox="0 0 128 72" style={{ width: "100%", maxWidth: "180px" }}>
        {/* Background track */}
        <path d={`M${cx - R},${cy} A${R},${R} 0 0,1 ${cx + R},${cy}`}
              fill="none" stroke={sc.track} strokeWidth="10" strokeLinecap="round"/>

        {/* Colored arc */}
        {ang > 0 && (
          <path d={`M${start.x},${start.y} A${R},${R} 0 ${large},1 ${end.x},${end.y}`}
                fill="none" stroke={sc.fill} strokeWidth="10" strokeLinecap="round"
                style={{ filter: `drop-shadow(0 0 4px ${sc.fill}88)` }}/>
        )}

        {/* Warn tick */}
        <line
          x1={cx + (R - 7) * Math.cos(rad(((warn - min) / (max - min)) * 180))}
          y1={cy - (R - 7) * Math.sin(rad(((warn - min) / (max - min)) * 180))}
          x2={cx + (R + 7) * Math.cos(rad(((warn - min) / (max - min)) * 180))}
          y2={cy - (R + 7) * Math.sin(rad(((warn - min) / (max - min)) * 180))}
          stroke="#f97316" strokeWidth="2"/>

        {/* Crit tick */}
        <line
          x1={cx + (R - 7) * Math.cos(rad(((crit - min) / (max - min)) * 180))}
          y1={cy - (R - 7) * Math.sin(rad(((crit - min) / (max - min)) * 180))}
          x2={cx + (R + 7) * Math.cos(rad(((crit - min) / (max - min)) * 180))}
          y2={cy - (R + 7) * Math.sin(rad(((crit - min) / (max - min)) * 180))}
          stroke="#dc2626" strokeWidth="2"/>

        {/* Needle */}
        <line
          x1={cx} y1={cy}
          x2={cx + 38 * Math.cos(rad(ang))}
          y2={cy - 38 * Math.sin(rad(ang))}
          stroke={needleColor} strokeWidth="2" strokeLinecap="round"/>
        <circle cx={cx} cy={cy} r="4" fill={needleColor}/>

        {/* Value text with background */}
        <rect x={cx - 20} y={cy - 8} width="40" height="16" rx="4" fill={textBgColor} opacity="0.95"/>
        <text x={cx} y={cy + 4} textAnchor="middle" dominantBaseline="middle"
              fontSize="14" fontWeight="800" fill={sc.text}
              fontFamily="'Inter',sans-serif" style={{ letterSpacing: "-0.5px" }}>
          {dispVal}
        </text>

        {/* Unit text with background */}
        <rect x={cx - 14} y={cy + 12} width="28" height="12" rx="3" fill={textBgColor} opacity="0.95"/>
        <text x={cx} y={cy + 18} textAnchor="middle"
              fontSize="8" fill={isDark ? "#cbd5e1" : "#94a3b8"} fontFamily="'Inter',sans-serif">
          {unit === "kW" ? "kW" : unit}
        </text>

        {/* Min label with background */}
        <rect x={cx - R - 12} y={cy + 8} width="24" height="12" rx="3" fill={textBgColor} opacity="0.95"/>
        <text x={cx - R} y={cy + 14} textAnchor="middle"
              fontSize="7" fill={isDark ? "#94a3b8" : "#cbd5e1"} fontFamily="monospace">{min}</text>

        {/* Max label with background */}
        <rect x={cx + R - 12} y={cy + 8} width="24" height="12" rx="3" fill={textBgColor} opacity="0.95"/>
        <text x={cx + R} y={cy + 14} textAnchor="middle"
              fontSize="7" fill={isDark ? "#94a3b8" : "#cbd5e1"} fontFamily="monospace">{max}</text>
      </svg>

      {/* Alert message */}
      {msg && msg !== "No Action" ? (
        <div style={{
          marginTop: "6px", fontSize: "12px", color: sc.text,
          background: "#fff", border: `1px solid ${sc.border}`,
          padding: "4px 10px", borderRadius: "8px",
          textAlign: "center", width: "100%",
          fontWeight: "600", lineHeight: "1.4",
        }}>{msg}</div>
      ) : (
        <div style={{
          marginTop: "6px", fontSize: "12px", color: "#94a3b8",
          padding: "4px 10px",
        }}>No Action Required</div>
      )}
    </div>
  );
}


// ── Overall Status Banner ─────────────────────────────────────────────────────
function OverallBanner({ overall, fanOn, smsOn, theme }) {
  const sc = SC[overall] || SC.Normal;
  const isDark = theme === 'dark';
  const icons = { High: "🚨", Medium: "⚠️", Low: "✅", Normal: "✅" };
  const msgs  = {
    High:   "CRITICAL — Immediate action required. Fan ON + SMS Alert sent.",
    Medium: "WARNING — Monitor closely. Fan activated.",
    Low:    "CAUTION — Minor anomaly. Fan ON as precaution.",
    Normal: "ALL SYSTEMS NOMINAL — No action required.",
  };
  return (
    <div style={{
      background: isDark ? "#1e293b" : sc.bg, 
      border: `2px solid ${isDark ? "#334155" : sc.fill}`,
      borderRadius: "16px", padding: "16px 24px",
      display: "flex", alignItems: "center", gap: "20px",
      marginBottom: "24px", flexWrap: "wrap",
      boxShadow: isDark ? "0 4px 24px rgba(0,0,0,0.3)" : `0 4px 24px ${sc.fill}33`,
      transition: "all 0.3s ease",
    }}>
      <div style={{ fontSize: "36px" }}>{icons[overall] || "✅"}</div>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: "11px", color: isDark ? "#94a3b8" : "#64748b", fontWeight: "600",
                      letterSpacing: "0.14em", marginBottom: "4px" }}>
          OVERALL SYSTEM STATUS
        </div>
        <div style={{ fontSize: "22px", fontWeight: "800", color: sc.fill,
                      letterSpacing: "0.06em" }}>
          {overall?.toUpperCase()}
        </div>
        <div style={{ fontSize: "11px", color: isDark ? "#cbd5e1" : "#475569", marginTop: "4px" }}>
          {msgs[overall] || msgs.Normal}
        </div>
      </div>
      <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
        <div style={{
          padding: "8px 16px", borderRadius: "10px",
          background: isDark ? (fanOn ? "#292415" : "#1e293b") : (fanOn ? "#fff7ed" : "#f8fafc"),
          border: `1.5px solid ${isDark ? (fanOn ? "#92400e" : "#334155") : (fanOn ? "#f97316" : "#e2e8f0")}`,
          textAlign: "center",
          transition: "all 0.3s ease",
        }}>
          <div style={{ fontSize: "9px", color: isDark ? "#cbd5e1" : "#94a3b8", letterSpacing: "0.1em" }}>FAN</div>
          <div style={{ fontSize: "14px", fontWeight: "800",
                        color: fanOn ? "#ea580c" : (isDark ? "#64748b" : "#cbd5e1") }}>
            {fanOn ? "■ ON" : "□ OFF"}
          </div>
        </div>
        <div style={{
          padding: "8px 16px", borderRadius: "10px",
          background: isDark ? (smsOn ? "#3f1f1f" : "#1e293b") : (smsOn ? "#fff5f5" : "#f8fafc"),
          border: `1.5px solid ${isDark ? (smsOn ? "#7f1d1d" : "#334155") : (smsOn ? "#dc2626" : "#e2e8f0")}`,
          textAlign: "center",
          animation: smsOn ? "blink 1.2s infinite" : "none",
          transition: "all 0.3s ease",
        }}>
          <div style={{ fontSize: "9px", color: isDark ? "#cbd5e1" : "#94a3b8", letterSpacing: "0.1em" }}>SMS</div>
          <div style={{ fontSize: "14px", fontWeight: "800",
                        color: smsOn ? "#dc2626" : (isDark ? "#64748b" : "#cbd5e1") }}>
            {smsOn ? "⚡ SENT" : "— IDLE"}
          </div>
        </div>
        
      </div>
    </div>
  );
}




// ── Clock ─────────────────────────────────────────────────────────────────────
function Clock({ theme }) {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const days  = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  const months= ["January","February","March","April","May","June",
                 "July","August","September","October","November","December"];

  const day   = days[now.getDay()];
  const date  = now.getDate();
  const month = months[now.getMonth()];
  const year  = now.getFullYear();
  const time  = now.toLocaleTimeString("en-IN", { hour12: true,
                  hour:"2-digit", minute:"2-digit", second:"2-digit" });

  return (
    <div style={{ textAlign: "right" }}>
      <div style={{ fontSize: "18px", fontWeight: "700", color: theme === 'dark' ? "#e2e8f0" : "#1e293b",
                    letterSpacing: "0.02em", fontFamily: "'Inter',sans-serif" }}>
        {time}
      </div>
      <div style={{ fontSize: "11px", color: theme === 'dark' ? "#cbd5e1" : "#64748b", marginTop: "2px" }}>
        {day}, {date} {month} {year}
      </div>
    </div>
  );
}

// ── Loading Alert Notification ────────────────────────────────────────────────
function LoadingAlert({ theme, onClose }) {
  return (
    <div style={{
      position: "fixed",
      top: "100px",
      right: "32px",
      background: theme === 'dark' ? "#1e293b" : "#fff",
      border: `2px solid #f59e0b`,
      borderRadius: "12px",
      padding: "16px 20px",
      boxShadow: theme === 'dark' ? "0 8px 32px rgba(0,0,0,0.5)" : "0 8px 32px rgba(245,158,11,0.2)",
      display: "flex",
      alignItems: "center",
      gap: "12px",
      zIndex: 1000,
      maxWidth: "360px",
      animation: "slideIn 0.3s ease-out",
    }}>
      <div style={{ fontSize: "20px" }}>⏳</div>
      <div style={{ flex: 1 }}>
        <div style={{
          fontSize: "13px",
          fontWeight: "700",
          color: theme === 'dark' ? "#fbbf24" : "#f59e0b",
          marginBottom: "2px",
          letterSpacing: "0.05em",
        }}>
          Taking a while...
        </div>
        <div style={{
          fontSize: "11px",
          color: theme === 'dark' ? "#cbd5e1" : "#64748b",
          lineHeight: "1.4",
        }}>
          Still fetching live data from the server. Please wait...
        </div>
      </div>
      <button onClick={onClose} style={{
        background: "none",
        border: "none",
        fontSize: "18px",
        cursor: "pointer",
        color: theme === 'dark' ? "#cbd5e1" : "#94a3b8",
        padding: "0",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        minWidth: "24px",
        minHeight: "24px",
        transition: "color 0.2s",
      }} onMouseEnter={(e) => {
        e.target.style.color = theme === 'dark' ? "#e2e8f0" : "#64748b";
      }} onMouseLeave={(e) => {
        e.target.style.color = theme === 'dark' ? "#cbd5e1" : "#94a3b8";
      }}>
        ✕
      </button>
    </div>
  );
}

// ── Main Dashboard ─────────────────────────────────────────────────────────────
export default function Dashboard() {
  const [idx,    setIdx]    = useState(0);
  // const [cur,    setCur]    = useState(() => parseRow(RAW[0]));


  const [paused, setPaused] = useState(false);
  const [tick,   setTick]   = useState(0);
  const [theme,  setTheme]  = useState('light');
  const timerRef = useRef(null);
  const timeoutRef = useRef(null);
  const hasDataRef = useRef(false);

  const [cur, setCur] = useState(null);
  const [showLoadingAlert, setShowLoadingAlert] = useState(false);
  const [reportProgress, setReportProgress] = useState(null);
  const [reportMessage, setReportMessage] = useState("");
  const [reportError, setReportError] = useState(false);

useEffect(() => {
  if (USE_DUMMY_DATA) {
    let dummyIndex = 0;

    const firstRow = DUMMY_DATA[dummyIndex];
    setCur(parseRow(firstRow));
    predictFromDummy(firstRow).then((res) => {
      if (res) {
        setCur(parseRow({ ...firstRow, ...res }));
      }
    });
    setShowLoadingAlert(false);

    const dummyTimer = setInterval(() => {
      dummyIndex = (dummyIndex + 1) % DUMMY_DATA.length;
      const row = {
        ...DUMMY_DATA[dummyIndex],
        created_at: new Date().toISOString(),
      };
      setCur(parseRow(row));
      predictFromDummy(row).then((res) => {
        if (res) {
          setCur(parseRow({ ...row, ...res }));
        }
      });
    }, DUMMY_INTERVAL_MS);

    return () => {
      clearInterval(dummyTimer);
    };
  }

  let isMounted = true;

  const fetchLatest = async () => {
    try {
      const data = await fetchJson("/live");
      if (!isMounted) return;
      setCur(parseRow(data));
      hasDataRef.current = true;
      setShowLoadingAlert(false);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    } catch (err) {
      console.error("Failed to fetch live data:", err);
    }
  };

  fetchLatest();
  const pollTimer = setInterval(fetchLatest, 3000);

  timeoutRef.current = setTimeout(() => {
    if (!hasDataRef.current) {
      setShowLoadingAlert(true);
      console.warn("Data loading taking longer than expected...");
    }
  }, 5000);

  return () => {
    isMounted = false;
    clearInterval(pollTimer);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
  };
}, []);

// ── Report Generation Handler ──────────────────────────────────────────
const handleGenerateReport = async (reportType) => {
  try {
    setReportProgress(0);
    setReportMessage("Fetching sensor data...");
    setReportError(false);
    
    const data = await fetchSensorData(1); // Last 24 hours
    
    if (!data || data.length === 0) {
      throw new Error("No sensor data available for the last 24 hours. Please check your data.");
    }

    switch(reportType) {
      case 'charts':
        await generateDailyChartsPDF(data, (prog, msg) => {
          setReportProgress(prog);
          setReportMessage(msg);
        });
        break;
      case 'graphs':
        await generateDailyGraphsPDF(data, (prog, msg) => {
          setReportProgress(prog);
          setReportMessage(msg);
        });
        break;
      case 'report':
        await generateDailyReportPDF(data, (prog, msg) => {
          setReportProgress(prog);
          setReportMessage(msg);
        });
        break;
      case 'summary':
        await generateSummaryPDF(data, (prog, msg) => {
          setReportProgress(prog);
          setReportMessage(msg);
        });
        break;
      default:
        throw new Error("Unknown report type");
    }
    
    // Clear progress after 2 seconds on success
    setTimeout(() => setReportProgress(null), 2000);
  } catch (error) {
    console.error(`Report generation failed:`, error);
    setReportError(true);
    setReportMessage(error.message || "Failed to generate report");
    // Keep error visible for 5 seconds
    setTimeout(() => setReportProgress(null), 5000);
  }
};

  
const overall = cur?.overall || "Normal";

const fanOn = cur?.fan ?? (overall === "High" || overall === "Medium");
const smsOn = cur?.sms ?? (overall === "High");

const themeStyles = {
  light: {
    bg: "#f8fafc",
    text: "#1e293b",
    headerBg: "#fff",
    headerBorder: "#e2e8f0",
    cardBg: "#fff",
    cardBorder: "#e2e8f0",
    buttonBg: "#f8fafc",
    buttonBorder: "#e2e8f0",
    buttonText: "#475569",
    labelText: "#64748b",
    secondaryText: "#94a3b8",
  },
  dark: {
    bg: "#0f172a",
    text: "#f1f5f9",
    headerBg: "#1e293b",
    headerBorder: "#334155",
    cardBg: "#1e293b",
    cardBorder: "#334155",
    buttonBg: "#334155",
    buttonBorder: "#475569",
    buttonText: "#cbd5e1",
    labelText: "#94a3b8",
    secondaryText: "#cbd5e1",
  },
};

const ts = themeStyles[theme];

  return (
    <div style={{
      height: "100vh",
      background: ts.bg,
      fontFamily: "'Inter','Segoe UI',sans-serif",
      color: ts.text,
      display: "flex",
      flexDirection: "column",
      overflow: "hidden",
      transition: "background 0.3s ease, color 0.3s ease",
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0.2} }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.6} }
        @keyframes slideIn { from { transform: translateX(400px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
        html { height: auto; overflow-y: scroll; scrollbar-gutter: stable; overflow-x: hidden; }
        body { min-height: 100vh; width: 100%; margin: 0; padding: 0; }
      `}</style>

      {/* ── Loading Alert Notification ──── */}
      {showLoadingAlert && (
        <LoadingAlert theme={theme} onClose={() => setShowLoadingAlert(false)} />
      )}

      {/* ── Report Progress Notification ──── */}
      {reportProgress !== null && (
        <ProgressNotification 
          theme={theme} 
          progress={reportProgress} 
          message={reportMessage} 
          error={reportError} 
        />
      )}

      {/* ── HEADER ─────────────────────────────────────────────────────── */}
      <div style={{
        background: ts.headerBg,
        borderBottom: `2px solid ${ts.headerBorder}`,
        padding: "0 32px",
        height: "76px",
        display: "flex", alignItems: "center",
        justifyContent: "space-between",
        boxShadow: theme === 'light' ? "0 2px 12px rgba(0,0,0,0.06)" : "0 2px 12px rgba(0,0,0,0.3)",
        flexShrink: 0,
        transition: "background 0.3s ease, border-color 0.3s ease",
      }}>

        {/* LEFT — CISH Block */}
        <div style={{ display: "flex", alignItems: "center", gap: "12px", minWidth: "200px" }}>
          <div style={{
            width: "46px", height: "46px", borderRadius: "12px",
            background: "linear-gradient(135deg, #1d4ed8, #2563eb)",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: "22px", boxShadow: "0 4px 12px #2563eb44",
            color:"white",
          }}>🖥</div>
          <div>
            <div style={{ fontSize: "16px", fontWeight: "800", color: ts.text,
                          letterSpacing: "0.04em" }}>CISH Block</div>
            <div style={{ fontSize: "10px", color: ts.labelText, letterSpacing: "0.12em",
                          marginTop: "1px" }}>Server Room Monitor</div>
          </div>
        </div>

        {/* CENTER — SASTRA Logo */}
        <div style={{ textAlign: "center", flex: 1 }}>
          <div style={{ display: "inline-flex", flexDirection: "column",
                        alignItems: "center", gap: "2px" }}>
            <div style={{
              fontSize: "22px", fontWeight: "800", letterSpacing: "0.18em",
              background: "linear-gradient(90deg, #1d4ed8, #0891b2)",
              WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
            }}>SASTRA</div>
            <div style={{
              fontSize: "9px", color: ts.labelText, letterSpacing: "0.18em",
              fontWeight: "600", borderTop: `1px solid ${ts.cardBorder}`,
              paddingTop: "3px", marginTop: "1px",
            }}>DEEMED TO BE UNIVERSITY</div>
            <div style={{ fontSize: "8px", color: ts.secondaryText, letterSpacing: "0.1em" }}>
              Smart Rack Monitoring System
            </div>
          </div>
        </div>

        {/* RIGHT — Date & Time */}
        <div style={{ display: "flex", flexDirection: "column",
                      alignItems: "flex-end", minWidth: "200px", gap: "6px" }}>
          <Clock theme={theme}/>
          <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
            {/* Live dot */}
            <span style={{ width: "7px", height: "7px", borderRadius: "50%",
                           background: paused ? "#f59e0b" : "#16a34a",
                           display: "inline-block",
                           boxShadow: paused ? "0 0 6px #f59e0b" : "0 0 8px #16a34a",
                           animation: paused ? "none" : "blink 2s infinite" }}/>
            <span style={{ fontSize: "9px", color: ts.labelText,
                           fontWeight: "600", letterSpacing: "0.1em" }}>
              {/* {paused ? "PAUSED" : `LIVE · ${tick} readings`} */}
            </span>
            <button onClick={() => setPaused(p => !p)} style={{
              padding: "4px 10px", borderRadius: "6px",
              border: `1.5px solid ${ts.buttonBorder}`, background: ts.buttonBg,
              color: ts.buttonText, fontSize: "9px", fontWeight: "700",
              cursor: "pointer", fontFamily: "inherit", letterSpacing: "0.08em",
              transition: "all 0.3s ease",
            }}>{paused ? "▶ PLAY" : "⏸ PAUSE"}</button>
            <button onClick={() => setTheme(t => t === 'light' ? 'dark' : 'light')} style={{
              padding: "4px 10px", borderRadius: "6px",
              border: `1.5px solid ${ts.buttonBorder}`, background: ts.buttonBg,
              color: ts.buttonText, fontSize: "9px", fontWeight: "700",
              cursor: "pointer", fontFamily: "inherit", letterSpacing: "0.08em",
              transition: "all 0.3s ease",
            }}>{theme === 'light' ? "🌙 DARK" : "☀ LIGHT"}</button>
          </div>
        </div>
      </div>

      {/* ── BODY ───────────────────────────────────────────────────────── */}
      <div style={{ 
        flex: 1,
        padding: "16px 32px",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        gap: "8px",
      }}>

        {/* Overall Banner */}
        {cur ? (
          <OverallBanner overall={overall} fanOn={fanOn} smsOn={smsOn} theme={theme}/>
        ) : (
          <div style={{
            background: theme === 'dark' ? "#1e293b" : "#fff",
            border: `2px solid ${theme === 'dark' ? "#334155" : "#e2e8f0"}`,
            borderRadius: "16px",
            padding: "16px 24px",
            display: "flex",
            alignItems: "center",
            gap: "20px",
            marginBottom: "24px",
            animation: "pulse 2s infinite",
            minHeight: "100px",
          }}>
            <div style={{
              width: "36px",
              height: "36px",
              borderRadius: "50%",
              background: theme === 'dark' ? "#334155" : "#cbd5e1",
              opacity: 0.5,
            }} />
            <div style={{ flex: 1 }}>
              <div style={{
                height: "16px",
                background: theme === 'dark' ? "#334155" : "#cbd5e1",
                borderRadius: "4px",
                marginBottom: "8px",
                width: "40%",
                opacity: 0.5,
              }} />
              <div style={{
                height: "24px",
                background: theme === 'dark' ? "#334155" : "#cbd5e1",
                borderRadius: "4px",
                marginBottom: "8px",
                width: "60%",
                opacity: 0.5,
              }} />
              <div style={{
                height: "14px",
                background: theme === 'dark' ? "#334155" : "#cbd5e1",
                borderRadius: "4px",
                width: "70%",
                opacity: 0.5,
              }} />
            </div>
          </div>
        )}
       
        {/* TWO-COLUMN LAYOUT: Left (Gauges) | Right (AI + Admin) */}
        <div style={{
          display: "grid",
          gridTemplateColumns: "4fr 1fr",
          gap: "8px",
          flex: 1,
          overflow: "hidden",
        }}>
          
          {/* ── LEFT PANE: All Gauge Meters ────────────────────────────── */}
          <div style={{
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
          }}>
            <div style={{
              fontSize: "12px",
              fontWeight: "700",
              color: "#64748b",
              letterSpacing: "0.12em",
              marginBottom: "8px",
              flexShrink: 0,
            }}>
              SENSOR GAUGES
            </div>
            <div style={{
              display: "grid",
              gridTemplateColumns: "repeat(4, 1fr)",
              gap: "8px",
              flex: 1,
              overflow: "hidden",
            }}>
             
              
             {SENSORS.map(cfg => (
                cur ? (
                  <ArcGauge
                    key={cfg.key}
                    value={cur?.[cfg.key] ?? 0}
                    min={cfg.min} max={cfg.max}
                    warn={cfg.warn} crit={cfg.crit}
                    status={cur?.[cfg.sk] ?? "Normal"}
                    label={cfg.label} unit={cfg.unit} icon={cfg.icon}
                    msg={cur?.[cfg.mk] ?? "No Action"}
                    theme={theme}
                  />
                ) : (
                  <SkeletonGauge key={cfg.key} theme={theme} />
                )
              ))}


            </div>
          </div>

          {/* ── RIGHT PANE: Two Rows (AI cur & Admin) ───────────── */}
          <div style={{
            display: "grid",
            gridTemplateRows: "1fr 1fr",
            gap: "4px",
            overflow: "hidden",
          }}>
            
            {/* ── ROW 1: AI cur Panel ──────────────────────────── */}
            <div style={{
              background: ts.cardBg,
              border: `1px solid ${ts.cardBorder}`,
              borderRadius: "12px",
              padding: "8px 10px",
              boxShadow: theme === 'light' ? "0 2px 10px rgba(0,0,0,0.05)" : "0 2px 10px rgba(0,0,0,0.2)",
              overflow: "hidden",
              transition: "background 0.3s ease, border-color 0.3s ease",
            }}>
              <div style={{
                fontSize: "10px",
                fontWeight: "700",
                color: ts.labelText,
                letterSpacing: "0.12em",
                marginBottom: "3px",
                display: "flex",
                alignItems: "center",
                gap: "6px",
              }}>
                <span style={{ fontSize: "14px" }}>🤖</span>
                AI Predicition
              </div>

              { cur ? (
                <div style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: "4px",
                  flex: 1,
                  overflow: "hidden",
                  height:"90%",
                }}>
                  
                  <div style={{
                    background: theme === 'dark' ? "#1e293b" : (SC[cur.cur]?.bg || "#f0fdf4"),
                    border: `1.5px solid ${theme === 'dark' ? "#334155" : (SC[cur.cur]?.border || "#86efac")}`,
                    borderRadius: "8px",
                    padding: "4px",
                    textAlign: "center",
                    display:"flex",
                    flexDirection:"column",
                    justifyContent:"center",
                  }}>
                    <div style={{ fontSize: "12px", color: theme === 'dark' ? "#cbd5e1" : "#94a3b8", fontWeight: "600" }}>Predicition</div>
                    <div style={{
                      fontSize: "18px",
                      fontWeight: "800",
                      marginTop: "1px",
                      color: theme === 'dark' ? SC[cur.cur]?.fill || "#e2e8f0" : (SC[cur.cur]?.fill || "#1e293b")
                    }}>
                      {cur.cur}
                    </div>
                  </div>

                  <div style={{
                    background: theme === 'dark' ? "#292415" : "#fff7ed",
                    border: `1.5px solid ${theme === 'dark' ? "#92400e" : "#fdba74"}`,
                    borderRadius: "8px",
                    padding: "4px",
                    textAlign: "center",
                    display:"flex",
                    flexDirection:"column",
                    justifyContent:"center",
                  }}>
                    <div style={{ fontSize: "12px", color: theme === 'dark' ? "#cbd5e1" : "#94a3b8", fontWeight: "600" }}>FAN ACTION</div>
                    <div style={{
                      fontSize: "18px",
                      fontWeight: "800",
                      marginTop: "1px",
                      color: cur.actions?.fan ? (theme === 'dark' ? "#fb923c" : "#ea580c") : (theme === 'dark' ? "#cbd5e1" : "#cbd5e1")
                    }}>
                      {cur.actions?.fan ? "✓ ON" : "✗ OFF"}
                    </div>
                  </div>

                  <div style={{
                    background: cur.actions?.sms ? (theme === 'dark' ? "#3f1f1f" : "#fff5f5") : (theme === 'dark' ? "#1e2e2a" : "#f0fdf4"),
                    border: `1.5px solid ${cur.actions?.sms ? (theme === 'dark' ? "#7f1d1d" : "#fca5a5") : (theme === 'dark' ? "#065f46" : "#86efac")}`,
                    borderRadius: "8px",
                    padding: "4px",
                    textAlign: "center",
                    display:"flex",
                    flexDirection:"column",
                    justifyContent:"center",
                  }}>
                    <div style={{ fontSize: "12px", color: theme === 'dark' ? "#cbd5e1" : "#94a3b8", fontWeight: "600" }}>SMS ALERT</div>
                    <div style={{
                      fontSize: "18px",
                      fontWeight: "800",
                      marginTop: "1px",
                      color: cur.actions?.sms ? (theme === 'dark' ? "#f87171" : "#dc2626") : (theme === 'dark' ? "#86efac" : "#15803d")
                    }}>
                      {cur.actions?.sms ? "⚡ SENT" : "— IDLE"}
                    </div>
                  </div>

                  <div style={{
                    background: cur.actions?.dashboard ? (theme === 'dark' ? "#3f1f1f" : "#fff5f5") : (theme === 'dark' ? "#1e2e2a" : "#f0fdf4"),
                    border: `1.5px solid ${cur.actions?.dashboard ? (theme === 'dark' ? "#7f1d1d" : "#fca5a5") : (theme === 'dark' ? "#065f46" : "#86efac")}`,
                    borderRadius: "8px",
                    padding: "4px",
                    textAlign: "center",
                    display:"flex",
                    flexDirection:"column",
                    justifyContent:"center",
                  }}>
                    <div style={{ fontSize: "12px", color: theme === 'dark' ? "#cbd5e1" : "#94a3b8", fontWeight: "600" }}>DASHBOARD</div>
                    <div style={{
                      fontSize: "18px",
                      fontWeight: "800",
                      marginTop: "1px",
                      color: cur.actions?.dashboard ? (theme === 'dark' ? "#f87171" : "#dc2626") : (theme === 'dark' ? "#86efac" : "#15803d")
                    }}>
                      {cur.actions?.dashboard ? "🚨 ALERT" : "✓ OK"}
                    </div>
                  </div>

                </div>
              ) : (
                <SkeletonPredictionPanel theme={theme} />
              )}
            </div>

            {/* ── ROW 2: Admin Section (PDF Downloads) ────────────────── */}
            <div style={{
              background: ts.cardBg,
              border: `1px solid ${ts.cardBorder}`,
              borderRadius: "12px",
              padding: "8px 10px",
              boxShadow: theme === 'light' ? "0 2px 10px rgba(0,0,0,0.05)" : "0 2px 10px rgba(0,0,0,0.2)",
              overflow: "hidden",
              display: "flex",
              flexDirection: "column",
              transition: "background 0.3s ease, border-color 0.3s ease",
            }}>
              <div style={{
                fontSize: "10px",
                fontWeight: "700",
                color: ts.labelText,
                letterSpacing: "0.12em",
                marginBottom: "3px",
                display: "flex",
                alignItems: "center",
                gap: "6px",
              }}>
                <span style={{ fontSize: "14px" }}>⚙️</span>
                ADMIN DOWNLOAD CENTER
              </div>

              <div style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: "4px",
                marginBottom: "0px",
                flex: 1,
                height: "90%",
              }}>
                
                {!cur ? (
                  <>
                    <SkeletonAdminButton theme={theme} />
                    <SkeletonAdminButton theme={theme} />
                    <SkeletonAdminButton theme={theme} />
                    <SkeletonAdminButton theme={theme} />
                  </>
                ) : (
                  <>
                    <button onClick={() => handleGenerateReport('charts')} style={{
                      padding: "10px 12px",
                      background: "linear-gradient(135deg, #3b82f6, #2563eb)",
                      color: "#fff",
                      border: "none",
                      borderRadius: "8px",
                      fontSize: "15px",
                      fontWeight: "700",
                      cursor: "pointer",
                      letterSpacing: "0.08em",
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: "4px",
                      transition: "all 0.3s ease",
                    }}>
                      <span style={{ fontSize: "20px" }}>📊</span> Charts (PDF)
                    </button>

                    <button onClick={() => handleGenerateReport('graphs')} style={{
                      padding: "10px 12px",
                      background: "linear-gradient(135deg, #8b5cf6, #7c3aed)",
                      color: "#fff",
                      border: "none",
                      borderRadius: "8px",
                      fontSize: "15px",
                      fontWeight: "700",
                      cursor: "pointer",
                      letterSpacing: "0.08em",
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: "4px",
                      transition: "all 0.3s ease",
                    }}>
                      <span style={{ fontSize: "20px" }}>📈</span> Data (CSV)
                    </button>

                    <button onClick={() => handleGenerateReport('report')} style={{
                      padding: "10px 12px",
                      background: "linear-gradient(135deg, #10b981, #059669)",
                      color: "#fff",
                      border: "none",
                      borderRadius: "8px",
                      fontSize: "15px",
                      fontWeight: "700",
                      cursor: "pointer",
                      letterSpacing: "0.08em",
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: "4px",
                      transition: "all 0.3s ease",
                    }}>
                      <span style={{ fontSize: "20px" }}>📄</span> Report (PDF)
                    </button>

                    <button onClick={() => handleGenerateReport('summary')} style={{
                      padding: "10px 12px",
                      background: "linear-gradient(135deg, #f59e0b, #d97706)",
                      color: "#fff",
                      border: "none",
                      borderRadius: "8px",
                      fontSize: "15px",
                      fontWeight: "700",
                      cursor: "pointer",
                      letterSpacing: "0.08em",
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: "4px",
                      transition: "all 0.3s ease",
                    }}>
                      <span style={{ fontSize: "20px" }}>📋</span> Summary (PDF)
                    </button>
                  </>
                )}

              </div>
            </div>

          </div>

        </div>

        {/* Footer info */}
        <div style={{
          padding: "8px 12px",
          background: theme === 'dark' ? "#1e293b" : "#fff",
          border: theme === 'dark' ? "1px solid #334155" : "1px solid #e2e8f0",
          borderRadius: "8px",
          display: "flex", justifyContent: "space-between",
          alignItems: "center", flexWrap: "wrap", gap: "6px",
          fontSize: "8px", color: theme === 'dark' ? "#cbd5e1" : "#94a3b8", letterSpacing: "0.08em",
          flexShrink: 0,
        }}>
          <span>AM2305B · PZEM-004T · WTVB01-485 · FST100-2010 · RS-YG-N01</span>
          {/* <span style={{ color: theme === 'dark' ? "#e2e8f0" : "#cbd5e1" }}>ROW {idx + 1}/{RAW.length}</span> */}
          <span>
            🟢 NORMAL/LOW &nbsp;|&nbsp;
            🟠 MEDIUM &nbsp;|&nbsp;
            🔴 HIGH/CRITICAL
          </span>
        </div>
      </div>
    </div>
  );
}

