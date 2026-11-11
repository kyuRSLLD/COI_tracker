'use strict'
// Example only, unmounted. Serve this script and HTML same-origin over HTTPS with
// no third-party code, analytics, service worker, logging of bodies, or redirects.
;(async () => {
  const message = document.getElementById('message')
  const list = document.getElementById('members')
  const token = location.hash.slice(1)
  const hasQuery = location.search !== ''
  try {
    // Remove fragment before initiating the API request or displaying any data.
    // If history replacement fails, do not send the capability at all.
    history.replaceState(null, '', location.pathname)
    if (hasQuery || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('invalid')
    const response = await fetch('/api/v2/client-report/redeem', {
      method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error',
      referrerPolicy: 'no-referrer', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
    if (!response.ok) throw new Error('unavailable')
    const data = await response.json()
    if (!data || data.schema !== 'anonymous-report-v1' || !Array.isArray(data.members) || data.members.length > 500) throw new Error('invalid')
    for (const member of data.members) {
      if (!member || !/^Member-[0-9a-f]{32}$/.test(member.label) || !['compliant','noncompliant','pending','unknown'].includes(member.status)) throw new Error('invalid')
    }
    // Never interpret report values as HTML and never display arbitrary properties.
    for (const member of data.members) {
      const li = document.createElement('li')
      li.textContent = `${member.label}: ${member.status}`
      list.appendChild(li)
    }
    message.textContent = data.members.length ? 'Project status' : 'No members in this report.'
  } catch {
    list.replaceChildren()
    message.textContent = 'This report is unavailable or has expired.'
  }
})()
