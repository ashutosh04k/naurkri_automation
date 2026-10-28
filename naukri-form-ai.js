/**
 * naukri-form-ai.js
 * Intelligent Form & Chatbot Drawer Filler for Naukri Applications.
 * Combines 100% free heuristic rule engine with free Gemini Flash AI fallback.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// Helper to sanitize strings for comparison
function clean(str) {
  return String(str || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Loads custom question-to-answer overrides from custom-answers.json
 */
function loadCustomAnswers() {
  try {
    const p = path.join(__dirname, 'custom-answers.json');
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    }
  } catch {}
  return {};
}

/**
 * Calls Gemini Flash REST API with a timeout
 */
async function askGemini(prompt, geminiKey, timeoutMs = 3000) {
  if (!geminiKey) return null;

  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiKey}`;
      const payload = JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 60,
        },
      });

      const u = new URL(url);
      const req = https.request({
        hostname: u.hostname,
        port: 443,
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: timeoutMs,
      }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          clearTimeout(timer);
          try {
            const json = JSON.parse(body);
            const ans = json?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
            resolve(ans || null);
          } catch {
            resolve(null);
          }
        });
      });

      req.on('error', () => {
        clearTimeout(timer);
        resolve(null);
      });
      req.on('timeout', () => {
        req.destroy();
        clearTimeout(timer);
        resolve(null);
      });

      req.write(payload);
      req.end();
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

/**
 * Resolve answer for a given question and available options/inputType
 */
async function resolveAnswer({ question, options = [], inputType = 'text', CV = {}, geminiKey = null }) {
  const q = clean(question);
  const optsClean = options.map(o => ({ original: o, clean: clean(o) }));
  const hasOptions = options.length > 0;

  // Helper to match an option
  const findOption = (predicate) => {
    const found = optsClean.find(predicate);
    return found ? found.original : null;
  };

  // Helper to extract numbers from a string
  const extractNum = (str, def = 0) => {
    const m = String(str || '').match(/\d+(\.\d+)?/);
    return m ? parseFloat(m[0]) : def;
  };

  const expYears = extractNum(CV.yearsOfExperience, 3);
  const currentCtcNum = extractNum(CV.currentCTC, 8);
  const expectedCtcNum = extractNum(CV.expectedCTC, 15);
  const noticeDays = extractNum(CV.noticePeriod, 15);

  // 0. User-defined Custom Question Overrides (from custom-answers.json)
  const customMap = loadCustomAnswers();
  for (const [key, val] of Object.entries(customMap)) {
    if (q.includes(clean(key))) {
      if (hasOptions) {
        const opt = findOption(o => o.clean === clean(val) || o.clean.includes(clean(val)) || clean(val).includes(o.clean));
        if (opt) return opt;
      }
      return String(val);
    }
  }

  // 1. Notice Period / Availability
  if (q.includes('notice') || q.includes('serving notice') || q.includes('availability') || q.includes('how soon') || q.includes('joining time') || q.includes('join in')) {
    if (q.includes('serving notice')) {
      // "Are you currently serving notice period?"
      const opt = findOption(o => o.clean === 'yes' || o.clean.includes('serving'));
      if (opt) return opt;
      if (findOption(o => o.clean === 'no')) return findOption(o => o.clean === 'no');
    }

    if (hasOptions) {
      // First, try to find option matching candidate's specific notice period
      if (noticeDays === 30 || clean(CV.noticePeriod).includes('30') || clean(CV.noticePeriod).includes('month')) {
        const opt30 = findOption(o => o.clean.includes('30') || o.clean.includes('1 month') || o.clean.includes('one month') || o.clean.includes('month'));
        if (opt30) return opt30;
      }
      if (noticeDays === 15 || clean(CV.noticePeriod).includes('15')) {
        const opt15 = findOption(o => o.clean.includes('15'));
        if (opt15) return opt15;
      }
      if (clean(CV.noticePeriod).includes('immediate') || noticeDays === 0) {
        const optImm = findOption(o => o.clean.includes('immediate') || o.clean.includes('0 days'));
        if (optImm) return optImm;
      }

      // Fallback: look for 15, 30, immediate, or 1 month
      const optAny = findOption(o => o.clean.includes('15') || o.clean.includes('30') || o.clean.includes('immediate') || o.clean.includes('1 month'));
      if (optAny) return optAny;
      return options[0];
    }

    if (inputType === 'number' || q.includes('in days') || q.includes('number of days')) {
      return String(noticeDays || 30);
    }
    return CV.noticePeriod || '30 Days';
  }

  // Range-matching helper
  const findClosestRangeOption = (targetVal) => {
    let bestOpt = null;
    let minDistance = Infinity;

    for (const item of optsClean) {
      const nums = item.clean.match(/\d+(\.\d+)?/g);
      if (nums && nums.length >= 2) {
        const min = parseFloat(nums[0]);
        const max = parseFloat(nums[1]);
        let dist = 0;
        if (targetVal < min) dist = min - targetVal;
        else if (targetVal > max) dist = targetVal - max;
        else dist = 0;

        if (dist < minDistance) {
          minDistance = dist;
          bestOpt = item.original;
        }
      } else if (nums && nums.length === 1) {
        const val = parseFloat(nums[0]);
        const dist = Math.abs(targetVal - val);
        if (dist < minDistance) {
          minDistance = dist;
          bestOpt = item.original;
        }
      }
    }
    return bestOpt;
  };

  // 2. Expected CTC
  if (q.includes('expected') || q.includes('expectation') || q.includes('minimum ctc') || q.includes('budget')) {
    if (hasOptions) {
      const best = findClosestRangeOption(expectedCtcNum);
      if (best) return best;
      return options[options.length > 1 ? 1 : 0];
    }
    if (inputType === 'number') return String(expectedCtcNum);
    return CV.expectedCTC || `${expectedCtcNum} LPA`;
  }

  // 3. Current CTC / Present Salary
  if (q.includes('current ctc') || q.includes('current salary') || q.includes('present ctc') || q.includes('current fixed') || q.includes('current package') || q.includes('present salary')) {
    if (hasOptions) {
      const best = findClosestRangeOption(currentCtcNum);
      if (best) return best;
      return options[0];
    }
    if (inputType === 'number') return String(currentCtcNum);
    return CV.currentCTC || `${currentCtcNum} LPA`;
  }

  // 4. Relocation / Work From Office / Hybrid / Onsite
  if (q.includes('relocat') || q.includes('work from office') || q.includes('wfo') || q.includes('hybrid') || q.includes('onsite') || q.includes('open to move') || q.includes('willing to')) {
    const yesOpt = findOption(o => o.clean === 'yes' || o.clean.startsWith('yes'));
    if (yesOpt) return yesOpt;
    if (hasOptions) {
      // Check if options are cities
      const myLoc = clean(CV.location);
      const locOpt = findOption(o => myLoc.includes(o.clean) || o.clean.includes(myLoc));
      if (locOpt) return locOpt;
      return options[0];
    }
    return 'Yes';
  }

  // 5. Work Authorization / Visa / Sponsorship
  if (q.includes('sponsorship') || q.includes('visa sponsorship') || q.includes('require sponsor')) {
    const noOpt = findOption(o => o.clean === 'no' || o.clean.startsWith('no'));
    if (noOpt) return noOpt;
    return 'No';
  }
  if (q.includes('authorized') || q.includes('legally') || q.includes('work permit') || q.includes('citizen') || q.includes('right to work')) {
    const yesOpt = findOption(o => o.clean === 'yes' || o.clean.startsWith('yes'));
    if (yesOpt) return yesOpt;
    return 'Yes';
  }

  // 6. Experience in a Skill or Total Experience
  if (q.includes('experience') || q.includes('hands on') || q.includes('worked with') || q.includes('proficiency')) {
    const isTotalExp = q.includes('total') || q.includes('overall');
    const targetYears = isTotalExp ? expYears : Math.min(expYears, 3);

    if (hasOptions) {
      // Is it a Yes/No question?
      const yesOpt = findOption(o => o.clean === 'yes' || o.clean.startsWith('yes'));
      if (yesOpt && (q.includes('do you have') || q.includes('are you') || q.includes('have you'))) {
        return yesOpt;
      }

      // Check closest range or year options
      const best = findClosestRangeOption(targetYears);
      if (best) return best;
      return options[0];
    }

    if (inputType === 'number' || q.includes('years') || q.includes('how many')) {
      return String(targetYears);
    }
    return `${targetYears} years`;
  }

  // 7. Location / Current City
  if (q.includes('location') || q.includes('current city') || q.includes('where do you live') || q.includes('based out of') || q.includes('residing')) {
    if (hasOptions) {
      const myLoc = clean(CV.location);
      const locOpt = findOption(o => myLoc.includes(o.clean) || o.clean.includes(myLoc));
      if (locOpt) return locOpt;
      return options[0];
    }
    return CV.location || 'India';
  }

  // 8. Highest Qualification / Education
  if (q.includes('qualification') || q.includes('education') || q.includes('degree') || q.includes('graduat')) {
    if (hasOptions) {
      const degOpt = findOption(o => o.clean.includes('b tech') || o.clean.includes('bachelor') || o.clean.includes('graduate') || o.clean.includes('engineering') || o.clean.includes('b e'));
      if (degOpt) return degOpt;
      return options[0];
    }
    return CV.education || 'Bachelor of Technology';
  }

  // 9. Gender
  if (q.includes('gender')) {
    if (hasOptions) {
      const genOpt = findOption(o => o.clean === clean(CV.gender) || o.clean.includes('male') || o.clean.includes('prefer not to say'));
      if (genOpt) return genOpt;
      return options[0];
    }
    return CV.gender || 'Male';
  }

  // 10. General Affirmative Screening (Yes / No)
  const yesOpt = findOption(o => o.clean === 'yes' || o.clean.startsWith('yes'));
  const noOpt = findOption(o => o.clean === 'no' || o.clean.startsWith('no'));
  if (yesOpt && noOpt) {
    // If it asks if anything disqualifying, e.g. criminal, dismissed, etc.
    if (q.includes('convicted') || q.includes('criminal') || q.includes('backlog') || q.includes('bond') || q.includes('breach')) {
      return noOpt;
    }
    return yesOpt;
  }

  // 11. Tier 2: AI Fallback with Gemini if available
  if (geminiKey) {
    const prompt = `You are filling a job application on Naukri.com for this candidate:
Name: ${CV.name || 'Candidate'}
Current Role: ${CV.currentRole || 'Software Engineer'}
Skills: ${CV.skills || 'React, Node.js, JavaScript, MongoDB, MERN Stack'}
Total Experience: ${expYears} years
Notice Period: ${CV.noticePeriod || '15 Days'}
Current CTC: ${currentCtcNum} LPA
Expected CTC: ${expectedCtcNum} LPA
Location: ${CV.location || 'India'}
Open to Relocate: Yes
Work Authorization: Citizen / No sponsorship needed

Question: "${question}"
${hasOptions ? `Available Options: [${options.map(o => `"${o}"`).join(', ')}]` : ''}
Field Type: ${inputType}

Rules:
1. If options are given, choose EXACTLY one of the provided options that is best for the candidate. Return ONLY that option string verbatim.
2. If it's a number/count field, output ONLY the number (e.g. 3 or 15).
3. If it's a free-text answer, provide a professional, positive 1-sentence answer.
4. Output ONLY the answer, with no quotes or extra text.`;

    const aiAnswer = await askGemini(prompt, geminiKey);
    if (aiAnswer) {
      if (hasOptions) {
        const matched = optsClean.find(o => clean(aiAnswer).includes(o.clean) || o.clean.includes(clean(aiAnswer)));
        if (matched) return matched.original;
      }
      return aiAnswer;
    }
  }

  // Final fallback
  if (hasOptions) return options[0];
  if (inputType === 'number') return '3';
  return 'Yes';
}

/**
 * Main function: Interacts with the active application drawer or modal on the page
 * Loops through questions sequentially until submitted or drawer closes.
 */
async function handleApplicationDrawer(page, { CV, geminiKey, log = console.log }) {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // Success indicators
  const isComplete = async () => {
    return page.evaluate(() => {
      const bodyText = (document.body && document.body.innerText) || '';
      const successPatterns = [
        /applied\s*to/i,
        /application\s*(submitted|sent|successful)/i,
        /successfully\s*applied/i,
        /already\s*applied/i,
        /you\s*have\s*applied/i,
        /application\s*received/i,
      ];
      for (const p of successPatterns) {
        if (p.test(bodyText)) return true;
      }

      // Check for success banners / messages
      const successEls = document.querySelectorAll(
        '.apply-message, .success-msg, [class*="apply-message"], [class*="success-msg"], [class*="already-applied"], [class*="applied-status"]'
      );
      for (const el of successEls) {
        if (el.offsetParent !== null && /applied|submitted|success/i.test(el.innerText || '')) {
          return true;
        }
      }

      // Check if main apply button changed to "Applied"
      const applyBtns = document.querySelectorAll('button.apply-button, #apply-button, [class*="apply-button"], button');
      for (const b of applyBtns) {
        const t = (b.innerText || '').trim().toLowerCase();
        if (t === 'applied' || t.includes('already applied')) return true;
      }

      return false;
    });
  };

  log('  [Form/Chatbot]: Inspecting application drawer & screener questions...');

  // Max 10 interaction steps to prevent infinite loop
  for (let step = 1; step <= 10; step++) {
    await sleep(2000);

    // 1. Check if application already finished
    if (await isComplete()) {
      log('  [Form/Chatbot]: Application confirmed complete!');
      return true;
    }

    // 2. Select default resume if a resume picker is shown
    await page.evaluate(() => {
      const resumeRadio = document.querySelector('input[type="radio"][name*="resume"], input[type="radio"][value*="resume"], .resume-item input[type="radio"]');
      if (resumeRadio && !resumeRadio.checked) resumeRadio.click();
    }).catch(() => {});

    // 3. Locate active drawer or modal
    const drawerInfo = await page.evaluate(() => {
      // Find candidate containers
      const containers = Array.from(document.querySelectorAll(
        '.chatbot_Drawer, .chatbot-container, .drawer-wrapper, [class*="chat-window"], [class*="bot-container"], [class*="drawer"], [role="dialog"], .modal-container, .apply-message, form'
      )).filter(el => {
        const rect = el.getBoundingClientRect();
        return rect.width > 100 && rect.height > 100 && window.getComputedStyle(el).display !== 'none' && window.getComputedStyle(el).visibility !== 'hidden';
      });

      const container = containers[0] || document.body;

      // Find question text
      const botMessages = Array.from(container.querySelectorAll(
        '.bot-msg, .bot-message, [class*="botMsg"], [class*="bot-text"], [class*="msgContent"], [class*="question"], [class*="ques-text"], .msg-box, .msg, label, legend, p'
      )).filter(el => {
        const text = (el.innerText || '').trim();
        return text.length > 5 && !/^(skip|submit|apply|save|next|cancel|close)/i.test(text);
      });

      const lastQuestionText = botMessages.length > 0 ? (botMessages[botMessages.length - 1].innerText || '').trim() : '';

      // Check for clickable chips / option pills
      const chips = Array.from(container.querySelectorAll(
        'button[class*="chip"], span[class*="chip"], div[class*="chip"], li[class*="chip"], .bot-selection-item, [class*="option-item"], [class*="pill"], [class*="chip-item"], [class*="radio-item"], [class*="selection-item"]'
      )).filter(el => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && el.innerText && el.innerText.trim();
      }).map(el => el.innerText.trim());

      // Check for radio inputs
      const radios = Array.from(container.querySelectorAll('input[type="radio"]')).filter(r => {
        const rect = r.getBoundingClientRect();
        return rect.width > 0 || r.offsetParent !== null;
      }).map(r => {
        const label = container.querySelector(`label[for="${r.id}"]`) || r.closest('label');
        return {
          id: r.id,
          name: r.name,
          value: r.value,
          label: label ? label.innerText.trim() : r.value,
        };
      });

      // Check for text inputs
      const textInputs = Array.from(container.querySelectorAll(
        'input[type="text"], input[type="number"], input:not([type]), textarea'
      )).filter(i => {
        const rect = i.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && !i.disabled && !i.readOnly;
      }).map(i => ({
        id: i.id,
        name: i.name,
        type: i.type || 'text',
        placeholder: i.placeholder || '',
        value: i.value || '',
      }));

      // Check for select elements
      const selects = Array.from(container.querySelectorAll('select')).filter(s => {
        const rect = s.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && !s.disabled;
      }).map(s => ({
        id: s.id,
        name: s.name,
        options: Array.from(s.options).map(o => ({ text: o.text.trim(), value: o.value })),
      }));

      return {
        hasContainer: containers.length > 0,
        question: lastQuestionText,
        chips,
        radios,
        textInputs,
        selects,
      };
    });

    log(`  [Form/Chatbot Step ${step}]: Active question context: "${(drawerInfo.question || 'General Questionnaire').slice(0, 60)}"`);

    let acted = false;

    // A. Handle select dropdowns
    if (drawerInfo.selects.length > 0) {
      for (const sel of drawerInfo.selects) {
        const optTexts = sel.options.map(o => o.text).filter(Boolean);
        const chosen = await resolveAnswer({
          question: drawerInfo.question || sel.name,
          options: optTexts,
          inputType: 'select',
          CV,
          geminiKey,
        });

        log(`  [Form/Chatbot]: Selecting dropdown option: "${chosen}"`);
        const matchingOpt = sel.options.find(o => o.text.toLowerCase() === chosen.toLowerCase()) || sel.options[0];
        if (matchingOpt) {
          const loc = page.locator(`select[id="${sel.id}"], select[name="${sel.name}"]`).first();
          if (await loc.isVisible().catch(() => false)) {
            await loc.selectOption({ value: matchingOpt.value }).catch(() => {});
            acted = true;
          }
        }
      }
    }

    // B. Handle chips / option pills
    if (drawerInfo.chips.length > 0) {
      log(`  [Form/Chatbot]: Found chips: [${drawerInfo.chips.join(', ')}]`);
      const chosen = await resolveAnswer({
        question: drawerInfo.question,
        options: drawerInfo.chips,
        inputType: 'chip',
        CV,
        geminiKey,
      });

      log(`  [Form/Chatbot]: Selected chip: "${chosen}"`);

      // Click the matching chip
      const clicked = await page.evaluate((targetText) => {
        const chipElements = Array.from(document.querySelectorAll(
          'button[class*="chip"], span[class*="chip"], div[class*="chip"], li[class*="chip"], .bot-selection-item, [class*="option-item"], [class*="pill"], [class*="chip-item"], [class*="radio-item"], [class*="selection-item"]'
        ));
        const match = chipElements.find(el => (el.innerText || '').trim().toLowerCase() === targetText.toLowerCase());
        if (match) {
          match.click();
          return true;
        }
        return false;
      }, chosen);

      if (clicked) {
        acted = true;
        await sleep(1500);
      }
    }

    // C. Handle radio buttons if no chips were clicked
    if (!acted && drawerInfo.radios.length > 0) {
      const radioLabels = drawerInfo.radios.map(r => r.label);
      log(`  [Form/Chatbot]: Found radios: [${radioLabels.join(', ')}]`);
      const chosen = await resolveAnswer({
        question: drawerInfo.question,
        options: radioLabels,
        inputType: 'radio',
        CV,
        geminiKey,
      });

      log(`  [Form/Chatbot]: Selected radio: "${chosen}"`);
      await page.evaluate((targetLabel) => {
        const radios = Array.from(document.querySelectorAll('input[type="radio"]'));
        for (const r of radios) {
          const lbl = document.querySelector(`label[for="${r.id}"]`) || r.closest('label');
          const t = lbl ? lbl.innerText.trim().toLowerCase() : r.value.toLowerCase();
          if (t === targetLabel.toLowerCase()) {
            r.click();
            if (lbl) lbl.click();
            break;
          }
        }
      }, chosen);

      acted = true;
      await sleep(1000);
    }

    // D. Handle text/number inputs
    if (drawerInfo.textInputs.length > 0) {
      for (const input of drawerInfo.textInputs) {
        // If already filled, skip
        if (input.value && input.value.trim().length > 0) continue;

        const effectiveQ = drawerInfo.question || input.placeholder || input.name;
        const answer = await resolveAnswer({
          question: effectiveQ,
          inputType: input.type,
          CV,
          geminiKey,
        });

        log(`  [Form/Chatbot]: Typing answer into input (${input.placeholder || input.type}): "${answer}"`);

        const loc = page.locator(`input[id="${input.id}"], input[name="${input.name}"], input[placeholder="${input.placeholder}"], textarea`).first();
        if (await loc.isVisible().catch(() => false)) {
          await loc.fill(String(answer)).catch(() => {});
          await sleep(500);

          // In chatbot, press Enter to submit message bubble
          await loc.press('Enter').catch(() => {});
          acted = true;
          // In a chatbot drawer, process one input at a time
          if (drawerInfo.hasContainer) break;
        }
      }

      // Check if chatbot has a separate Send button
      const sendBtn = page.locator('button.send-btn, button[class*="send"], [class*="sendIcon"], [class*="send-icon"]').first();
      if (await sendBtn.isVisible().catch(() => false)) {
        await sendBtn.click().catch(() => {});
        await sleep(1500);
      }
    }

    // E. Check for Submit / Save & Apply button
    const submitBtn = page.locator([
      'button:has-text("Save & Apply")',
      'button:has-text("Save and Apply")',
      'button:has-text("Submit Application")',
      'button:has-text("Submit")',
      'button:has-text("Apply Now")',
      'button:has-text("Apply")',
      'button:has-text("Confirm")',
      'button[type="submit"]',
    ].join(', ')).first();

    if (await submitBtn.isVisible().catch(() => false)) {
      log('  [Form/Chatbot]: Clicking Submit / Apply button...');
      await submitBtn.click().catch(() => {});
      await sleep(2500);

      if (await isComplete()) {
        log('  [Form/Chatbot]: Application successfully submitted!');
        return true;
      }
    }

    // If nothing was acted upon and no action button, check if completed
    if (!acted && drawerInfo.chips.length === 0 && drawerInfo.textInputs.length === 0) {
      if (await isComplete()) return true;
      // If modal has closed, break out
      if (!drawerInfo.hasContainer) {
        log('  [Form/Chatbot]: Drawer closed or not present.');
        break;
      }
    }
  }

  // Final check
  return await isComplete();
}

module.exports = {
  clean,
  loadCustomAnswers,
  resolveAnswer,
  askGemini,
  handleApplicationDrawer,
};
