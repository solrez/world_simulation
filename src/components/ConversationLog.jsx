import { useEffect, useRef } from 'react';

export function ConversationLog({ activeConversations = [], pastConversations, people, events = [] }) {
  const scrollRef = useRef(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [activeConversations.reduce((s, c) => s + c.lines.length, 0), pastConversations.length, events.length]);

  const getColor = (name) => {
    if (name === 'narrator') return '#6a7a5a';
    const p = people.find(pp => pp.name === name);
    return p ? `#${p.color.toString(16).padStart(6, '0')}` : '#888';
  };

  // show recent events (ambient, death, god, seasonal)
  const recentEvents = events.slice(-8).filter(e =>
    e.type === 'ambient' || e.type === 'death' || e.type === 'god' || e.type === 'seasonal' ||
    e.type === 'partnership' || e.type === 'pregnancy' || e.type === 'birth' || e.type === 'breakup' ||
    e.type === 'conflict' || e.type === 'building' || e.type === 'kindness'
  );

  return (
    <div className="conversation-log" ref={scrollRef}>
      <div className="log-columns">
        <div className="log-conversations">
          <div className="section-label">Conversations</div>

          {activeConversations.map((convo, ci) => (
            convo.lines.length > 0 && (
              <div key={`active-${convo.id || ci}`} className="active-convo">
                <div className="convo-header active">
                  <span className="convo-indicator">● LIVE</span>
                  <span className="convo-participants">{convo.participants.join(', ')}</span>
                  <span className="convo-location">@ {convo.location}</span>
                </div>
                {convo.lines.slice(-4).map((line, i) => (
                  <div key={i} className={`convo-line ${line.speaker === 'narrator' ? 'narrator' : ''}`}>
                    {line.speaker === 'narrator' ? (
                      <span className="convo-narrator">{line.text}</span>
                    ) : (
                      <>
                        <span className="convo-speaker" style={{ color: getColor(line.speaker) }}>
                          {line.speaker}
                          {line.addressedTo && line.addressedTo !== 'everyone' && (
                            <span className="convo-addressed"> → {line.addressedTo}</span>
                          )}:
                        </span>
                        <span className="convo-text">{line.text}</span>
                        {line.thought && <div className="convo-thought">💭 {line.thought}</div>}
                      </>
                    )}
                  </div>
                ))}
              </div>
            )
          ))}

          {pastConversations.slice(-3).reverse().map((convo, ci) => (
            <div key={ci} className="past-convo">
              <div className="convo-header">
                <span className="convo-participants">{convo.participants.join(', ')}</span>
                <span className="convo-location">@ {convo.location}</span>
              </div>
              {convo.lines.slice(-3).map((line, i) => (
                <div key={i} className={`convo-line past ${line.speaker === 'narrator' ? 'narrator' : ''}`}>
                  {line.speaker === 'narrator' ? (
                    <span className="convo-narrator">{line.text}</span>
                  ) : (
                    <>
                      <span className="convo-speaker" style={{ color: getColor(line.speaker) }}>{line.speaker}:</span>
                      <span className="convo-text">{line.text}</span>
                    </>
                  )}
                </div>
              ))}
            </div>
          ))}

          {activeConversations.length === 0 && pastConversations.length === 0 && (
            <div className="no-convos">Waiting for villagers to meet...</div>
          )}
        </div>

        <div className="log-events">
          <div className="section-label">Village Chronicle</div>
          {recentEvents.length === 0 && <div className="no-convos">No events yet...</div>}
          {recentEvents.map((evt, i) => (
            <div key={i} className={`event-entry event-${evt.type}`}>
              <span className="event-text">{evt.summary}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
