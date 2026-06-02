using System;

namespace OsEngine.Indicators
{
    /// <summary>
    /// Attribute for applying indicators to terminal
    /// </summary>
    [AttributeUsage(AttributeTargets.Class)]
    public class IndicatorAttribute : Attribute
    {
        public string Name { get; }

        /// <summary>
        /// Preferred chart area (e.g. Prime, Second). When set, overrides UI selection on attach.
        /// </summary>
        public string ChartArea { get; }

        public IndicatorAttribute(string name)
        {
            Name = name;
        }

        public IndicatorAttribute(string name, string chartArea)
        {
            Name = name;
            ChartArea = chartArea;
        }
    }
}
