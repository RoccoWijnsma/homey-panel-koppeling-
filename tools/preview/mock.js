/** Synthetic household: base load, solar arc, appliance bursts and a big AC peak. */
function buildMock(now, spanMs, stepMs) {
  const series = { t: [], consumption: [], solar: [], net: [], peak: [] };
  const markers = [];
  const from = now - spanMs;
  let id = 0;

  const bursts = [
    { at: now - spanMs * 0.72, dur: spanMs * 0.10, watts: 2100, name: 'Washing Machine' },
    { at: now - spanMs * 0.46, dur: spanMs * 0.16, watts: 2400, name: 'EV Charger' },
    { at: now - spanMs * 0.22, dur: spanMs * 0.09, watts: 3300, name: 'Air Conditioning' },
  ];

  for (const burst of bursts) {
    markers.push({ id: `m${id++}`, t: burst.at, type: 'device_on', color: 'blue',
      label: `${burst.name} turned on`, watts: burst.watts });
    markers.push({ id: `m${id++}`, t: burst.at + burst.dur, type: 'device_off', color: 'blue',
      label: `${burst.name} turned off`, watts: 0 });
  }

  let solarPeakValue = 0; let solarPeakAt = 0;
  for (let t = from; t <= now; t += stepMs) {
    const dayFraction = ((t - from) / spanMs);
    const solarCurve = Math.sin(Math.PI * Math.min(1, Math.max(0, dayFraction * 1.15))) * 3400;
    let solar = Math.max(0, solarCurve + Math.sin(t / 900000) * 260);
    // A cloud bank right when the AC kicks in.
    if (t > now - spanMs * 0.23 && t < now - spanMs * 0.1) solar *= 0.35;
    if (solar > solarPeakValue) { solarPeakValue = solar; solarPeakAt = t; }

    let consumption = 320 + Math.sin(t / 420000) * 90 + Math.random() * 45;
    for (const burst of bursts) {
      if (t >= burst.at && t <= burst.at + burst.dur) consumption += burst.watts;
    }
    const net = consumption - solar;

    series.t.push(t);
    series.consumption.push(Math.round(consumption));
    series.solar.push(Math.round(solar));
    series.net.push(Math.round(net));
    series.peak.push(Math.round(consumption * 1.06));
  }

  markers.push({ id: `m${id++}`, t: solarPeakAt, type: 'solar_peak', color: 'amber',
    label: `Peak solar yield ${(solarPeakValue / 1000).toFixed(1)} kW`, watts: Math.round(solarPeakValue) });
  markers.push({ id: `m${id++}`, t: from + spanMs * 0.30, type: 'feed_in_start', color: 'teal',
    label: 'Net feed-in started', watts: 1240 });
  markers.push({ id: `m${id++}`, t: now - spanMs * 0.215, type: 'feed_in_end', color: 'teal',
    label: 'Net feed-in stopped', watts: 0 });
  markers.push({ id: `m${id++}`, t: now - spanMs * 0.215, type: 'peak', color: 'red',
    label: 'Power peak 3.6 kW', watts: 3620, delta: 3180,
    reason: 'Peak caused by Air Conditioning starting while solar yield dropped by 2.1 kW' });
  markers.push({ id: `m${id++}`, t: now - spanMs * 0.46, type: 'peak', color: 'red',
    label: 'Power peak 2.8 kW', watts: 2790, delta: 2400,
    reason: 'Peak caused by EV Charger starting' });
  markers.push({ id: `m${id++}`, t: now - spanMs * 0.08, type: 'custom', color: 'grey',
    label: 'Dishwasher eco programme' });

  markers.sort((a, b) => a.t - b.t);
  return { series, markers };
}

window.buildMock = buildMock;
