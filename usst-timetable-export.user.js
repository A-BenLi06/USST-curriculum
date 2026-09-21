// ==UserScript==
// @name         上海理工大学课表导出 ICS
// @namespace    https://jwgl.usst.edu.cn/
// @version      1.0.0
// @description  在个人课表查询页面解析课程、周次、节次、教师与地点，并导出为 iCalendar (.ics)。
// @author       Codex
// @match        https://jwgl.usst.edu.cn/jwglxt/kbcx/xskbcx_cxXskbcxIndex.html*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(() => {
  "use strict";

  const PERIOD_TIMES = {
    1: ["08:00", "08:40"],
    2: ["08:45", "09:25"],
    3: ["09:45", "10:25"],
    4: ["10:30", "11:10"],
    5: ["11:15", "11:55"],
    6: ["13:00", "13:40"],
    7: ["13:45", "14:25"],
    8: ["14:45", "15:25"],
    9: ["15:30", "16:10"],
    10: ["16:15", "16:55"],
    11: ["18:00", "18:40"],
    12: ["18:45", "19:25"],
    13: ["19:30", "20:10"],
  };

  const KNOWN_FIRST_MONDAYS = {
    "2026-2027-1": "2026-09-07",
  };

  const clean = (value) => String(value || "").trim().replace(/\s+/g, " ");

  function selectedText(selector) {
    const element = document.querySelector(selector);
    return clean(element?.selectedOptions?.[0]?.textContent || element?.value);
  }

  function parsePeriodAndWeeks(value) {
    const normalized = clean(value).replace(/[—–~～]/g, "-");
    const match = normalized.match(/\((\d+)\s*-\s*(\d+)\s*节\)\s*(.+)$/u);
    if (!match) throw new Error(`无法识别节次/周次：${value}`);
    return {
      startPeriod: Number(match[1]),
      endPeriod: Number(match[2]),
      weekSpec: match[3],
      weeks: expandWeeks(match[3]),
    };
  }

  function expandWeeks(value) {
    const source = clean(value)
      .replace(/[—–~～]/g, "-")
      .replace(/，/g, ",")
      .replace(/周/g, "");
    const oddOnly = /[（(]单[）)]/.test(source);
    const evenOnly = /[（(]双[）)]/.test(source);
    const numeric = source.replace(/[（(][单双][）)]/g, "");
    const weeks = [];
    for (const part of numeric.split(",")) {
      const match = part.trim().match(/^(\d+)(?:-(\d+))?$/);
      if (!match) continue;
      const start = Number(match[1]);
      const end = Number(match[2] || match[1]);
      for (let week = start; week <= end; week += 1) {
        if (oddOnly && week % 2 === 0) continue;
        if (evenOnly && week % 2 !== 0) continue;
        weeks.push(week);
      }
    }
    const unique = [...new Set(weeks)].sort((a, b) => a - b);
    if (!unique.length) throw new Error(`无法识别周次：${value}`);
    return unique;
  }

  function parseSchedule() {
    const cells = [...document.querySelectorAll("#kbgrid_table_0 td.td_wrap")];
    if (!cells.length) throw new Error("没有找到课表。请先查询课表，并切换到“表格”视图。");

    return cells.flatMap((cell) => {
      const idMatch = cell.id.match(/^(\d+)-(\d+)$/);
      if (!idMatch) return [];
      const weekday = Number(idMatch[1]);
      return [...cell.querySelectorAll(":scope > .timetable_con")].map((course) => {
        const paragraphs = [...course.querySelectorAll(":scope > p")].map((p) => clean(p.innerText));
        const period = parsePeriodAndWeeks(paragraphs[0]);
        return {
          weekday,
          name: clean(course.querySelector(".title")?.textContent).replace(/[★○◆◇●]+$/u, ""),
          ...period,
          location: paragraphs[1] || "",
          teacher: paragraphs[2] || "",
          assessment: paragraphs[3] || "",
          hours: paragraphs[4] || "",
          weeklyHours: paragraphs[5] || "",
          totalHours: paragraphs[6] || "",
          credits: paragraphs[7] || "",
        };
      });
    });
  }

  function addDays(isoDate, days) {
    const [year, month, day] = isoDate.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day + days));
    return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}`;
  }

  function escapeIcs(value) {
    return String(value)
      .replace(/\\/g, "\\\\")
      .replace(/\n/g, "\\n")
      .replace(/,/g, "\\,")
      .replace(/;/g, "\\;");
  }

  function foldLine(line) {
    const encoder = new TextEncoder();
    const chunks = [];
    let chunk = "";
    let bytes = 0;
    for (const char of line) {
      const width = encoder.encode(char).length;
      const limit = chunks.length ? 74 : 75;
      if (bytes + width > limit && chunk) {
        chunks.push(chunk);
        chunk = char;
        bytes = width;
      } else {
        chunk += char;
        bytes += width;
      }
    }
    chunks.push(chunk);
    return chunks.join("\r\n ");
  }

  function simpleHash(value) {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i += 1) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  function recurrenceLines(weeks) {
    if (weeks.length <= 1) return [];
    const interval = weeks[1] - weeks[0];
    const regular = weeks.every((week, index) => index === 0 || week - weeks[index - 1] === interval);
    return regular ? [`RRULE:FREQ=WEEKLY;INTERVAL=${interval};COUNT=${weeks.length}`] : [];
  }

  function buildIcs(courses, options) {
    const now = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    const lines = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//USST Timetable Exporter//ZH-CN",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      `X-WR-CALNAME:${escapeIcs(`上海理工大学 ${options.academicYear}-${options.term} 课表`)}`,
      "X-WR-TIMEZONE:Asia/Shanghai",
      "BEGIN:VTIMEZONE",
      "TZID:Asia/Shanghai",
      "X-LIC-LOCATION:Asia/Shanghai",
      "BEGIN:STANDARD",
      "TZOFFSETFROM:+0800",
      "TZOFFSETTO:+0800",
      "TZNAME:CST",
      "DTSTART:19700101T000000",
      "END:STANDARD",
      "END:VTIMEZONE",
    ];

    for (const course of courses) {
      const firstWeek = course.weeks[0];
      const eventDate = addDays(options.firstMonday, (firstWeek - 1) * 7 + course.weekday - 1);
      const startTime = PERIOD_TIMES[course.startPeriod]?.[0];
      const endTime = PERIOD_TIMES[course.endPeriod]?.[1];
      if (!startTime || !endTime) throw new Error(`未知节次：${course.startPeriod}-${course.endPeriod}`);
      const startStamp = `${eventDate}T${startTime.replace(":", "")}00`;
      const endStamp = `${eventDate}T${endTime.replace(":", "")}00`;
      const uidSeed = [options.academicYear, options.term, course.weekday, course.startPeriod, course.name, course.location].join("|");
      const description = [
        `教师：${course.teacher}`,
        `节次：第${course.startPeriod}-${course.endPeriod}节`,
        `周次：${course.weekSpec}`,
        `考核：${course.assessment}`,
        `学时组成：${course.hours}`,
        `学分：${course.credits}`,
      ].join("\n");

      lines.push(
        "BEGIN:VEVENT",
        `UID:${simpleHash(uidSeed)}-${simpleHash(uidSeed.split("").reverse().join(""))}@usst-course`,
        `DTSTAMP:${now}`,
        `DTSTART;TZID=Asia/Shanghai:${startStamp}`,
        `DTEND;TZID=Asia/Shanghai:${endStamp}`,
        ...recurrenceLines(course.weeks),
      );

      if (course.weeks.length > 1 && !recurrenceLines(course.weeks).length) {
        const extraDates = course.weeks.slice(1).map((week) => {
          const date = addDays(options.firstMonday, (week - 1) * 7 + course.weekday - 1);
          return `${date}T${startTime.replace(":", "")}00`;
        });
        lines.push(`RDATE;TZID=Asia/Shanghai:${extraDates.join(",")}`);
      }

      lines.push(
        `SUMMARY:${escapeIcs(course.name)}`,
        `LOCATION:${escapeIcs(course.location)}`,
        `DESCRIPTION:${escapeIcs(description)}`,
        "CATEGORIES:上海理工大学,课程",
      );

      if (options.reminderMinutes > 0) {
        lines.push(
          "BEGIN:VALARM",
          `TRIGGER:-PT${options.reminderMinutes}M`,
          "ACTION:DISPLAY",
          `DESCRIPTION:${escapeIcs(`${course.name} 即将开始`)}`,
          "END:VALARM",
        );
      }
      lines.push("END:VEVENT");
    }

    lines.push("END:VCALENDAR");
    return lines.map(foldLine).join("\r\n") + "\r\n";
  }

  function downloadIcs(content, filename) {
    const blob = new Blob(["\ufeff", content], { type: "text/calendar;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function showExportDialog() {
    let courses;
    try {
      courses = parseSchedule();
    } catch (error) {
      alert(error.message);
      return;
    }

    const academicYear = selectedText("#xnm");
    const term = selectedText("#xqm");
    const storageKey = `usst-ics-first-monday:${academicYear}-${term}`;
    const defaultDate = localStorage.getItem(storageKey) || KNOWN_FIRST_MONDAYS[`${academicYear}-${term}`] || "";
    const overlay = document.createElement("div");
    overlay.id = "usst-ics-overlay";
    overlay.innerHTML = `
      <div class="usst-ics-dialog" role="dialog" aria-modal="true" aria-labelledby="usst-ics-title">
        <h3 id="usst-ics-title">导出课表为 ICS</h3>
        <p>已识别 <strong>${courses.length}</strong> 个课程时段。日期按“第 1 周周一”计算，请务必核对。</p>
        <label>第 1 周周一
          <input id="usst-first-monday" type="date" value="${defaultDate}" required>
        </label>
        <label>提前提醒
          <select id="usst-reminder">
            <option value="0">不提醒</option>
            <option value="10">10 分钟</option>
            <option value="15" selected>15 分钟</option>
            <option value="30">30 分钟</option>
          </select>
        </label>
        <p class="usst-ics-note">采用上海理工大学 2026–2027 学年新版 13 节课时表；导入前可在文本中调整 PERIOD_TIMES。</p>
        <div class="usst-ics-actions">
          <button type="button" data-action="cancel">取消</button>
          <button type="button" class="primary" data-action="export">导出 .ics</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay || event.target.closest('[data-action="cancel"]')) close();
    });
    overlay.querySelector('[data-action="export"]').addEventListener("click", () => {
      const firstMonday = overlay.querySelector("#usst-first-monday").value;
      if (!firstMonday) {
        alert("请选择第 1 周周一的日期。");
        return;
      }
      const reminderMinutes = Number(overlay.querySelector("#usst-reminder").value);
      localStorage.setItem(storageKey, firstMonday);
      try {
        const ics = buildIcs(courses, { academicYear, term, firstMonday, reminderMinutes });
        downloadIcs(ics, `USST-${academicYear}-${term}-课表.ics`);
        close();
      } catch (error) {
        alert(`导出失败：${error.message}`);
      }
    });
  }

  function addStyles() {
    if (document.querySelector("#usst-ics-styles")) return;
    const style = document.createElement("style");
    style.id = "usst-ics-styles";
    style.textContent = `
      #usst-ics-export { margin-right: 8px; background: #16a085; border-color: #138d75; color: #fff; }
      #usst-ics-overlay { position: fixed; inset: 0; z-index: 99999; display: grid; place-items: center; background: rgba(15,23,42,.48); font-family: -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif; }
      .usst-ics-dialog { width: min(460px, calc(100vw - 32px)); padding: 24px; border-radius: 14px; background: #fff; box-shadow: 0 22px 70px rgba(15,23,42,.3); color: #1f2937; }
      .usst-ics-dialog h3 { margin: 0 0 12px; font-size: 21px; }
      .usst-ics-dialog p { margin: 8px 0 18px; line-height: 1.6; }
      .usst-ics-dialog label { display: grid; grid-template-columns: 120px 1fr; align-items: center; gap: 12px; margin: 12px 0; font-weight: 600; }
      .usst-ics-dialog input, .usst-ics-dialog select { min-height: 38px; padding: 6px 10px; border: 1px solid #cbd5e1; border-radius: 7px; background: #fff; }
      .usst-ics-dialog .usst-ics-note { color: #64748b; font-size: 13px; }
      .usst-ics-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px; }
      .usst-ics-actions button { padding: 8px 18px; border: 1px solid #cbd5e1; border-radius: 7px; background: #fff; cursor: pointer; }
      .usst-ics-actions .primary { border-color: #2563eb; background: #2563eb; color: #fff; }
    `;
    document.head.appendChild(style);
  }

  function installButton() {
    if (document.querySelector("#usst-ics-export")) return;
    const pdfButton = document.querySelector("#shcPDF");
    if (!pdfButton) return;
    addStyles();
    const button = document.createElement("button");
    button.id = "usst-ics-export";
    button.type = "button";
    button.className = pdfButton.className || "btn btn-default";
    button.textContent = "导出 ICS";
    button.addEventListener("click", showExportDialog);
    pdfButton.parentElement.insertBefore(button, pdfButton);
  }

  installButton();
  new MutationObserver(installButton).observe(document.body, { childList: true, subtree: true });
})();

