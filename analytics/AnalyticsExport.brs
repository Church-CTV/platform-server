Sub Init(config As Object)
    m_config = config
    m_exportUrl = m_config.exportUrl
    m_exportIntervalSeconds = m_config.exportIntervalSeconds
    m_maxEventsPerBatch = m_config.maxEventsPerBatch
    m_flushOnError = m_config.flushOnError

    ' Initialize event storage arrays
    m_screenHistory = []
    m_playHistory = []
    m_deepLinkHistory = []
    m_errorHistory = []

    ' Session tracking
    m_sessionStartTime = 0
    m_appVersion = ""
    m_deviceId = GetOrCreateDeviceId()
    m_traceId = GenerateTraceId()

    ' Start export timer
    m_exportTimer = CreateObject("roTimespan")
    m_lastExportTime = 0

    ' Network retry state
    m_consecutiveFailures = 0
    m_retryDelay = 10

    ' Register for app exit event
    m.port = "roURLTransfer"
End Sub

Function GetOrCreateDeviceId() As String
    ' Try to get deviceId from config
    config = m_config
    if config <> Invalid AND config.deviceId <> ""
        return config.deviceId
    end if

    ' Try to get from registry
    registry = CreateObject("roRegistrySection", "analytics")
    deviceId = registry.Read("deviceId")
    if deviceId <> ""
        return deviceId
    end if

    ' Generate a new UUID with improved entropy
    deviceId = GenerateUUID()

    ' Store in registry
    registry.Write("deviceId", deviceId)
    registry.Flush()

    ' Update config with deviceId
    if config <> Invalid
        config.deviceId = deviceId
    end if

    return deviceId
End Function

Function GenerateUUID() As String
    ' Seed RNG from registry or time
    registry = CreateObject("roRegistrySection", "analytics")
    seed = registry.Read("rnd_seed")
    if seed = "" OR seed = Invalid
        time = CreateObject("roDateTime")
        seed = CStr(time.TotalSeconds())
        registry.Write("rnd_seed", seed)
        registry.Flush()
    end if
    Rnd(Val(seed))

    hex = "0123456789abcdef"
    uuid = ""
    For i = 1 To 32
        idx = Rnd() * 16
        uuid = uuid + Mid(hex, Int(idx) + 1, 1)
    Next
    ' Insert hyphens for UUID format
    uuid = uuid.Left(8) + "-" + uuid.Middle(8, 4) + "-" + uuid.Middle(12, 4) + "-" + uuid.Middle(16, 4) + "-" + uuid.Middle(20, 12)
    return uuid
End Function

Function GenerateTraceId() As String
    ' Generate a 32-char hex trace ID (OTel format without hyphens)
    registry = CreateObject("roRegistrySection", "analytics")
    seed = registry.Read("rnd_seed")
    if seed = "" OR seed = Invalid
        time = CreateObject("roDateTime")
        seed = CStr(time.TotalSeconds())
        registry.Write("rnd_seed", seed)
        registry.Flush()
    end if
    Rnd(Val(seed))

    hex = "0123456789abcdef"
    traceId = ""
    For i = 1 To 32
        idx = Rnd() * 16
        traceId = traceId + Mid(hex, Int(idx) + 1, 1)
    Next
    return traceId
End Function

Sub RecordScreenView(screenName As String, previousScreen As String)
    event = CreateEventObject("screen_view", {
        "screenName": screenName,
        "previousScreen": previousScreen
    })
    m_screenHistory.Push(event)
End Sub

Sub RecordContentPlay(contentId As String, contentTitle As String, contentDuration As Double, sourceScreen As String)
    event = CreateEventObject("content_play", {
        "contentId": contentId,
        "contentTitle": contentTitle,
        "contentDuration": contentDuration,
        "sourceScreen": sourceScreen
    })
    m_playHistory.Push(event)
End Sub

Sub RecordDeepLink(contentId As String, mediaType As String, source As String)
    event = CreateEventObject("deep_link", {
        "contentId": contentId,
        "mediaType": mediaType,
        "source": source
    })
    m_deepLinkHistory.Push(event)
End Sub

Sub RecordError(errorType As String, errorMessage As String, context As String)
    event = CreateEventObject("error", {
        "errorType": errorType,
        "errorMessage": errorMessage,
        "context": context
    })
    m_errorHistory.Push(event)

    ' Error events always trigger immediate flush
    FlushEvents()
End Sub

Sub RecordInteraction(action As String, target As String, details As String)
    event = CreateEventObject("interaction", {
        "action": action,
        "target": target,
        "details": details
    })
    m_screenHistory.Push(event)
End Sub

Sub RecordPlaybackState(state As String, contentId As String)
    event = CreateEventObject("playback_state", {
        "state": state,
        "contentId": contentId
    })
    m_playHistory.Push(event)
End Sub

Function CreateEventObject(eventType As String, payload As Object) As Object
    timespan = CreateObject("roTimespan")
    timestamp = FormatTimestamp()
    sessionDuration = 0
    if m_sessionStartTime > 0
        sessionDuration = timespan.TotalSeconds() - m_sessionStartTime
    end if

    event = CreateObject("roAssociativeArray")
    event.eventType = eventType
    event.timestamp = timestamp
    event.sessionDuration = sessionDuration
    event.appVersion = m_appVersion
    event.deviceId = m_deviceId
    event.payload = payload

    return event
End Function

Function FormatTimestamp() As String
    ' Get current time in ISO 8601 format with timezone offset
    time = CreateObject("roDateTime")
    time.ClearCurrentTime()
    hours = time.GetHours()
    minutes = time.GetMinutes()
    seconds = time.GetSeconds()
    utcOffset = time.GetUTCOffset()
    offsetHours = Abs(Int(utcOffset / 3600))
    offsetMinutes = Int(Abs(utcOffset - offsetHours * 3600))
    offsetSign = If(utcOffset >= 0, "+", "-")
    return FormatStr("%04d-%02d-%02dT%02d:%02d:%02d%s%02d:%02d", [
        time.GetYear(), time.GetMonth(), time.GetDay(),
        hours, minutes, seconds,
        offsetSign, offsetHours, offsetMinutes
    ])
End Function

Sub SetAppVersion(version As String)
    m_appVersion = version
End Sub

Sub SetSessionStartTime()
    m_sessionStartTime = CreateObject("roTimespan").TotalSeconds()
End Sub

Sub FlushEvents()
    ' Collect all events from all history arrays
    allEvents = CollectAllEvents()

    if allEvents.Count() = 0
        return
    end if

    ' Truncate to maxEventsPerBatch
    if allEvents.Count() > m_maxEventsPerBatch
        allEvents = allEvents.Take(m_maxEventsPerBatch)
    end if

    ' Build export payload
    payload = CreateObject("roAssociativeArray")
    payload.events = allEvents
    payload.deviceInfo = {
        "deviceId": m_deviceId,
        "appVersion": m_appVersion,
        "channelName": m_config.channelName
    }

    ' Send to server
    SendToServer(payload)

    ' Clear history arrays
    m_screenHistory.Clear()
    m_playHistory.Clear()
    m_deepLinkHistory.Clear()
    m_errorHistory.Clear()

    m_lastExportTime = CreateObject("roTimespan").TotalSeconds()
End Sub

Function CollectAllEvents() As Object
    allEvents = CreateObject("roArray", 0, True)

    ' Combine all history arrays
    for each history in [m_screenHistory, m_playHistory, m_deepLinkHistory, m_errorHistory]
        if history <> Invalid
            for each event in history
                if event <> Invalid
                    allEvents.Push(event)
                end if
            end for
        end if
    end for

    return allEvents
End Function

Sub SendToServer(payload As Object)
    if m_exportUrl = "" OR m_exportUrl = Invalid
        print "[Analytics] No export URL configured"
        return
    end if

    urlTransfer = CreateObject("roUrlTransfer")
    urlTransfer.SetUrl(m_exportUrl)
    urlTransfer.SetPort(m.port)
    urlTransfer.AddHeader("Content-Type", "application/json")
    urlTransfer.AddHeader("Accept", "application/json")
    urlTransfer.AddHeader("X-Trace-Id", m_traceId)

    postData = ""
    try
        postData = payload.ToStr()
    catch e
        print "[Analytics] Error serializing payload: "; e.msg
        return
    end try

    urlTransfer.PostString(postData)

    ' Wait for response
    msg = Wait(5000, m.port)
    if msg <> Invalid
        statusCode = msg.GetResponseCode()
        if statusCode = 200
            m_consecutiveFailures = 0
            m_retryDelay = 10
            print "[Analytics] Successfully exported "; payload.events.Count(); " events"
        else
            m_consecutiveFailures = m_consecutiveFailures + 1
            print "[Analytics] Export failed with status: "; statusCode
        end if
    else
        m_consecutiveFailures = m_consecutiveFailures + 1
        print "[Analytics] Export timed out"
    end if
End Sub

Sub OnAppExit()
    ' Final export on app exit
    FlushEvents()
End Sub

Sub StartExportTimer()
    ' Periodic export timer
    While True
        msg = Wait(m_exportIntervalSeconds * 1000, m.port)
        if msg <> Invalid
            exit While
        end if

        ' Check if we need to flush
        timespan = CreateObject("roTimespan")
        elapsed = timespan.TotalSeconds() - m_lastExportTime
        if elapsed >= m_exportIntervalSeconds
            FlushEvents()
        end if
    End While
End Sub

Sub SetConfig(config As Object)
    m_config = config
    if config.exportUrl <> ""
        m_exportUrl = config.exportUrl
    end if
    if config.exportIntervalSeconds > 0
        m_exportIntervalSeconds = config.exportIntervalSeconds
    end if
    if config.maxEventsPerBatch > 0
        m_maxEventsPerBatch = config.maxEventsPerBatch
    end if
    if config.flushOnError <> Invalid
        m_flushOnError = config.flushOnError
    end if
End Sub
