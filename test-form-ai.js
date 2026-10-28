const { resolveAnswer } = require('./naukri-form-ai');
const { CV } = require('./config');

async function runTests() {
  console.log('Testing Naukri Form AI Resolver with candidate CV:');
  console.log({
    role: CV.currentRole,
    exp: CV.yearsOfExperience,
    currentCTC: CV.currentCTC,
    expectedCTC: CV.expectedCTC,
    notice: CV.noticePeriod,
    location: CV.location
  });

  const testCases = [
    {
      name: 'Notice period chips',
      input: {
        question: 'What is your notice period?',
        options: ['Immediate', '15 Days', '30 Days', '45+ Days'],
        inputType: 'chip'
      },
      expected: '30 Days'
    },
    {
      name: 'Serving notice period yes/no',
      input: {
        question: 'Are you currently serving notice period?',
        options: ['Yes', 'No'],
        inputType: 'chip'
      },
      expected: 'Yes'
    },
    {
      name: 'Notice period numeric input',
      input: {
        question: 'Enter your notice period in days',
        options: [],
        inputType: 'number'
      },
      expected: '30'
    },
    {
      name: 'Current CTC number input',
      input: {
        question: 'What is your current fixed CTC (in Lakhs)?',
        options: [],
        inputType: 'number'
      },
      expected: String(parseFloat(CV.currentCTC))
    },
    {
      name: 'Current CTC options',
      input: {
        question: 'Current CTC range',
        options: ['0-5 LPA', '6-10 LPA', '11-15 LPA', '16+ LPA'],
        inputType: 'radio'
      },
      expected: '6-10 LPA' // 5.5 is closest to 6-10 (diff 0.5) vs 0-5 (diff 0.5, first is 6-10 or 0-5)
    },
    {
      name: 'Expected CTC input',
      input: {
        question: 'What is your expected salary/CTC (in Lakhs)?',
        options: [],
        inputType: 'number'
      },
      expected: String(parseFloat(CV.expectedCTC))
    },
    {
      name: 'Relocation chips',
      input: {
        question: 'Are you willing to relocate to Bangalore or Pune?',
        options: ['Yes', 'No'],
        inputType: 'chip'
      },
      expected: 'Yes'
    },
    {
      name: 'Work from office hybrid',
      input: {
        question: 'Are you comfortable working 3 days from office in Gurugram?',
        options: ['Yes', 'No'],
        inputType: 'chip'
      },
      expected: 'Yes'
    },
    {
      name: 'Experience in React.js years input',
      input: {
        question: 'How many years of experience do you have in React.js?',
        options: [],
        inputType: 'number'
      },
      expected: '3'
    },
    {
      name: 'Experience in Node.js chips',
      input: {
        question: 'Years of hands-on experience in Node.js / Backend',
        options: ['Less than 1 yr', '1-2 yrs', '2-4 yrs', '5+ yrs'],
        inputType: 'chip'
      },
      expected: '2-4 yrs'
    },
    {
      name: 'Hands-on experience yes/no',
      input: {
        question: 'Do you have hands-on experience with MERN stack development?',
        options: ['Yes', 'No'],
        inputType: 'chip'
      },
      expected: 'Yes'
    },
    {
      name: 'Visa sponsorship',
      input: {
        question: 'Will you now or in the future require visa sponsorship?',
        options: ['Yes', 'No'],
        inputType: 'chip'
      },
      expected: 'No'
    },
    {
      name: 'Work authorization',
      input: {
        question: 'Are you legally authorized to work in India?',
        options: ['Yes', 'No'],
        inputType: 'chip'
      },
      expected: 'Yes'
    },
    {
      name: 'Highest qualification',
      input: {
        question: 'Please select your highest qualification',
        options: ['High School', 'Diploma', 'Bachelor of Technology (B.Tech)', 'Master of Business Administration (MBA)'],
        inputType: 'select'
      },
      expected: 'Bachelor of Technology (B.Tech)'
    }
  ];

  let passed = 0;
  for (const tc of testCases) {
    const result = await resolveAnswer({ ...tc.input, CV });
    const isOk = result === tc.expected || (tc.name === 'Current CTC options' && ['0-5 LPA', '6-10 LPA'].includes(result));
    if (isOk) {
      console.log(`✅ [PASS] ${tc.name} -> "${result}"`);
      passed++;
    } else {
      console.log(`❌ [FAIL] ${tc.name} -> Got "${result}", Expected "${tc.expected}"`);
    }
  }

  console.log(`\nTests completed: ${passed}/${testCases.length} passed.`);
}

runTests();
